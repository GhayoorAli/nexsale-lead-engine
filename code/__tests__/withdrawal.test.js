const R = require('../replies');
const CRM = require('../crm');

const lead = (status, extra) => Object.assign({ id: 'recL1', company_name: 'Sinus Clean', email: 'info@sinus-clean.de', contact_name: 'Sükrü Oral', status }, extra);
const booked = { id: 'recM1', lead_record_id: 'recL1', status: 'Booked', start_time: '2026-11-20T09:00:00.000Z' };

describe('withdrawalPlan: a lead says no after showing interest', () => {
  test('Interested + deal → not interested: close the deal, Slack says so', () => {
    const p = R.withdrawalPlan({ branch: 'Not interested', lead: lead('Interested', { hubspot_deal_id: '123' }), meetings: [] });
    expect(p.withdrew).toBe(true);
    expect(p.crmSync).toBe(true);
    expect(p.cancelMeetingIds).toEqual([]);
    expect(p.text).toMatch(/Sinus Clean\* withdrew after showing interest \(not interested\)/);
    expect(p.text).toMatch(/HubSpot deal set to Closed lost/);
  });
  test('Meeting booked → STOP: cancel the booked meeting, close the deal, ask to cancel in Calendly', () => {
    const p = R.withdrawalPlan({ branch: 'Unsubscribe', lead: lead('Meeting booked', { hubspot_deal_id: '123' }), meetings: [booked] });
    expect(p.cancelMeetingIds).toEqual(['recM1']);
    expect(p.crmSync).toBe(true);
    expect(p.text).toMatch(/STOP, added to the Blocklist/);
    expect(p.text).toMatch(/2026-11-20 09:00 marked cancelled: \*please cancel it in Calendly too\*/);
  });
  test('only Booked meetings of this lead are cancelled', () => {
    const others = [booked, { id: 'recM2', lead_record_id: 'recOTHER', status: 'Booked' }, { id: 'recM3', lead_record_id: 'recL1', status: 'Cancelled' }];
    expect(R.withdrawalPlan({ branch: 'Not interested', lead: lead('Meeting booked'), meetings: others }).cancelMeetingIds).toEqual(['recM1']);
  });
  test('interested but not yet in HubSpot → no CRM sync (never creates a closed deal)', () => {
    const p = R.withdrawalPlan({ branch: 'Not interested', lead: lead('Interested'), meetings: [] });
    expect(p.withdrew).toBe(true);
    expect(p.crmSync).toBe(false);
    expect(p.text).not.toMatch(/HubSpot/);
  });
  test('a first "no" from a contacted lead is not a withdrawal', () => {
    const p = R.withdrawalPlan({ branch: 'Not interested', lead: lead('Contacted'), meetings: [] });
    expect(p).toEqual({ withdrew: false, cancelMeetingIds: [], meetings: [], crmSync: false, text: '' });
  });
  test('other branches never withdraw', () => {
    ['Interested', 'Later', 'Out of office', 'Bounce', 'Unmatched', 'Unsure'].forEach((branch) => {
      expect(R.withdrawalPlan({ branch, lead: lead('Meeting booked', { hubspot_deal_id: '1' }), meetings: [booked] }).withdrew).toBe(false);
    });
  });
  test('works without lead name or meetings', () => {
    const p = R.withdrawalPlan({ branch: 'Not interested', lead: { hubspot_deal_id: '9' }, fromEmail: 'a@b.de' });
    expect(p.text).toMatch(/^:leftwards_arrow_with_hook: \*a@b\.de\*/);
    expect(R.withdrawalPlan().withdrew).toBe(false);
  });
});

describe('HubSpot: a withdrawn lead closes its deal', () => {
  test('Not interested and Unsubscribed map to closedlost', () => {
    expect(CRM.DEAL_STAGES['Not interested']).toBe('closedlost');
    expect(CRM.DEAL_STAGES.Unsubscribed).toBe('closedlost');
    expect(CRM.isClosing('Not interested')).toBe(true);
    expect(CRM.isClosing('Interested')).toBe(false);
  });
  test('deal update: Closed lost with reason and close date', () => {
    const d = CRM.dealProps(lead('Not interested'), null, '').properties;
    expect(d.dealstage).toBe('closedlost');
    expect(d.closed_lost_reason).toBe('Lead hat nach Interesse abgesagt');
    expect(typeof d.closedate).toBe('string');
    expect(CRM.dealProps(lead('Unsubscribed')).properties.closed_lost_reason).toMatch(/STOP/);
  });
  test('contact is marked UNQUALIFIED; an interested one stays IN_PROGRESS', () => {
    expect(CRM.contactProps(lead('Unsubscribed')).properties.hs_lead_status).toBe('UNQUALIFIED');
    expect(CRM.contactProps(lead('Interested')).properties.hs_lead_status).toBe('IN_PROGRESS');
  });
  test('open stages get no closed-lost reason', () => {
    const d = CRM.dealProps(lead('Meeting booked'), booked).properties;
    expect(d.dealstage).toBe('appointmentscheduled');
    expect(d.closed_lost_reason).toBeUndefined();
    expect(d.closedate).toBe('2026-11-20T09:00:00.000Z');
    expect(CRM.closedLostReason(lead('No-show'))).toMatch(/nicht zum Termin/);
  });
});

describe('automatic cancellation in Calendly', () => {
  const C2 = require('../calendly');
  const R2 = require('../replies');
  const lead2 = { id: 'recL1', company_name: 'Sinus Clean', status: 'Meeting booked', hubspot_deal_id: '7' };
  const m1 = { id: 'recM1', lead_record_id: 'recL1', status: 'Booked', start_time: '2026-11-20T09:00:00.000Z', calendly_event_id: 'EVT-123' };
  const m2 = { id: 'recM2', lead_record_id: 'recL1', status: 'Reminded', start_time: '2026-11-16T09:00:00.000Z', calendly_event_id: 'EVT-456' };
  test('a meeting that already got its reminder is cancelled too', () => {
    expect(R2.withdrawalPlan({ branch: 'Not interested', lead: lead2, meetings: [m1, m2] }).cancelMeetingIds).toEqual(['recM1', 'recM2']);
  });
  test('the cancellation call: event uuid, reason, safe characters only', () => {
    expect(C2.cancellationRequest(m1)).toEqual({ meeting_id: 'recM1', uuid: 'EVT-123', path: '/scheduled_events/EVT-123/cancellation', body: { reason: 'Der Interessent hat den Termin abgesagt.' } });
    expect(C2.cancellationRequest({ id: 'x', calendly_event_id: '../users/me' }).uuid).toBe('usersme');
    expect(C2.cancellationRequest({ id: 'x' }).path).toBe('/scheduled_events/missing/cancellation');
    expect(C2.cancellationRequest(m1, 'x'.repeat(400)).body.reason).toHaveLength(300);
  });
  test('result: 201 ok; 403/404 or no answer = problem with a short reason', () => {
    expect(C2.cancellationOk({ statusCode: 201 })).toBe(true);
    expect(C2.cancellationOk({ statusCode: 403 })).toBe(false);
    expect(C2.cancellationOk(null)).toBe(false);
    expect(C2.cancellationProblem({ statusCode: 403, body: { title: 'Permission Denied' } })).toBe('403 Permission Denied');
    expect(C2.cancellationProblem({})).toBe(' no answer');
  });
  test('Slack text: automatic when Calendly confirmed, manual hint (with the reason) when not', () => {
    const plan = R2.withdrawalPlan({ branch: 'Not interested', lead: lead2, meetings: [m1, m2] });
    const t = R2.withdrawalText(plan, [{ ok: true }, { ok: false, problem: '403 Permission Denied' }]);
    expect(t).toMatch(/Meeting on 2026-11-20 09:00 cancelled in Calendly automatically/);
    expect(t).toMatch(/Meeting on 2026-11-16 09:00 marked cancelled: \*please cancel it in Calendly too\* \(Calendly: 403 Permission Denied\)/);
    expect(t).toMatch(/HubSpot deal set to Closed lost/);
    expect(plan.text).toMatch(/please cancel it in Calendly too\*\./); // before the calls ran
  });
});
