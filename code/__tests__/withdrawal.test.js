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
    expect(p).toEqual({ withdrew: false, cancelMeetingIds: [], crmSync: false, text: '' });
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
