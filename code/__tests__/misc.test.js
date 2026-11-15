const REP = require('../report');
const IN = require('../inbound');
const CRM = require('../crm');
const AT = require('../airtable');
const CAL = require('../calendly');
const REM = require('../reminders');
const GD = require('../gdpr');
const SM = require('../slackMessages');
const SCH = require('../schedule');
const quiz = require('../../tests/fixtures/webhooks/quiz_submission.json');
const created = require('../../tests/fixtures/webhooks/calendly_invitee_created.json');
const canceled = require('../../tests/fixtures/webhooks/calendly_invitee_canceled.json');

const NOW = '2026-11-20T10:00:00.000Z';
const data = {
  clients: [{ id: 'K1', name: 'Real Service GmbH', target_positive_replies: 20, target_meetings: 4 }],
  campaigns: [{ id: 'C1', name: 'Cleaning Berlin', status: 'Live', client: ['K1'], google_api_cost_eur: 0.032, ai_cost_eur: 0.068 }, { id: 'C2', name: 'Old', status: 'Draft', client: ['K1'] }],
  leads: [
    { id: 'L1', campaign: ['C1'], status: 'Meeting booked', sourced_at: '2026-11-14T10:00:00Z' },
    { id: 'L2', campaign: ['C1'], status: 'Contacted', sourced_at: '2026-11-14T10:00:00Z' },
    { id: 'L3', campaign: ['C1'], status: 'Rejected', sourced_at: '2026-11-14T10:00:00Z' },
    { id: 'L4', campaign_record_id: 'C1', status: 'New', sourced_at: '2026-11-14T10:00:00Z' },
  ],
  emails: [
    { lead: ['L1'], status: 'Sent', sent_at: '2026-11-16T09:00:00Z' },
    { lead: ['L2'], status: 'Sent', sent_at: '2026-11-16T09:00:00Z' },
    { lead: ['L2'], status: 'Approved' },
  ],
  replies: [{ lead: ['L1'], category: 'Interested', received_at: '2026-11-17T09:00:00Z' }, { lead: ['L2'], category: 'Bounce', received_at: '2026-11-17T09:00:00Z' }],
  meetings: [{ lead: ['L1'], status: 'Booked', start_time: '2026-11-25T09:00:00Z' }, { lead: ['L1'], status: 'Cancelled', start_time: '2026-11-24T09:00:00Z' }],
};

describe('report', () => {
  test('campaign metrics equal a manual count', () => {
    const m = REP.campaignMetrics(data.campaigns[0], data);
    expect(m).toMatchObject({ leads_sourced: 4, enriched: 2, enriched_pct: 50, emails_sent: 2, contacted: 2, replied: 1, reply_rate_pct: 50, positive_replies: 1, meetings_booked: 1, meetings_held: 0, cost_eur: 0.1, cost_per_lead_eur: 0.025, cost_per_meeting_eur: 0.1 });
    expect(m.funnel).toEqual({ sourced: 4, enriched: 2, contacted: 2, replied: 1, interested: 1, meeting_booked: 1 });
  });
  test('empty campaign has zeros, not NaN', () => {
    const m = REP.campaignMetrics({ id: 'CX' }, {});
    expect(m.enriched_pct).toBe(0);
    expect(m.reply_rate_pct).toBe(0);
    expect(m.cost_per_lead_eur).toBe(0);
    expect(m.cost_per_meeting_eur).toBeNull();
  });
  test('guarantee tracker vs 20 / 4', () => {
    expect(REP.guaranteeTracker(data.clients[0], data, NOW)).toMatchObject({ positive_replies: 1, target_positive_replies: 20, positive_pct: 5, meetings: 1, target_meetings: 4, meetings_pct: 25 });
    expect(REP.guaranteeTracker({ id: 'K2' }, data, NOW).target_meetings).toBe(4);
    expect(REP.guaranteeTracker({ id: 'K2' }, data).meetings).toBe(0);
  });
  test('weekly facts only for active campaigns, last 7 days', () => {
    const f = REP.weeklyFacts(data, NOW);
    expect(f).toHaveLength(1);
    expect(f[0].emails_sent).toBe(2);
    expect(REP.weeklyFacts(data, '2027-01-01T00:00:00Z')[0].emails_sent).toBe(0);
    expect(REP.weeklyFacts({}).length).toBe(0);
  });
  test('progress bar and month start', () => {
    expect(REP.progressBar(25)).toBe('███░░░░░░░ 25%');
    expect(REP.progressBar(150)).toMatch(/^██████████/);
    expect(REP.monthStart('2026-11-20T10:00:00Z')).toBe('2026-11-01T00:00:00.000Z');
  });
});

describe('inbound', () => {
  test('quiz submission is normalised', () => {
    const r = IN.normaliseInbound(quiz);
    expect(r.ok).toBe(true);
    expect(r.lead).toMatchObject({ email: 'm.keller@keller-objektservice.example', domain: 'keller-objektservice.example', lead_type: 'Inbound quiz', company_name: 'Keller Objektservice GmbH' });
    expect(Object.keys(r.answers)).toHaveLength(6);
    expect(r.lead.inbound_answers).toMatch(/Wann möchten Sie starten\?: Sofort/);
  });
  test('Meta lead ad payload', () => {
    const r = IN.normaliseInbound({ body: { leadgen_id: '1', field_data: [{ name: 'email', values: ['A@Gmail.com'] }, { name: 'full_name', values: ['Anna'] }] } });
    expect(r.lead).toMatchObject({ lead_type: 'Inbound ad', email: 'a@gmail.com', contact_name: 'Anna', domain: 'gmail.com' });
  });
  test('invalid email', () => {
    expect(IN.normaliseInbound({ email: 'nope' }).ok).toBe(false);
    expect(IN.normaliseInbound(null).ok).toBe(false);
  });
  test('dedupe by email then domain (not for free mail)', () => {
    const leads = [{ id: 'A', email: 'x@firma.de', domain: 'firma.de' }, { id: 'B', email: 'y@gmail.com', domain: 'gmail.com' }];
    expect(IN.findExisting({ email: 'X@firma.de' }, leads).by).toBe('email');
    expect(IN.findExisting({ email: 'z@firma.de', domain: 'firma.de' }, leads).by).toBe('domain');
    expect(IN.findExisting({ email: 'q@gmail.com', domain: 'gmail.com' }, leads).existing).toBeNull();
    expect(IN.findExisting({ email: 'q@x.de' }).existing).toBeNull();
  });
  test('rule temperature fallback', () => {
    expect(IN.ruleTemperature(IN.normaliseInbound(quiz).answers)).toBe('hot');
    expect(IN.ruleTemperature({ a: 'vielleicht nächstes Jahr, 10 Termine' })).toBe('warm');
    expect(IN.ruleTemperature({})).toBe('cold');
  });
  test('task due: hot 15 min, warm same day, cold next day', () => {
    expect(IN.taskDueAt('hot', NOW, SCH)).toBe('2026-11-20T10:15:00.000Z');
    expect(IN.taskDueAt('warm', NOW, SCH)).toBe('2026-11-20T16:00:00.000Z');
    expect(IN.taskDueAt('warm', '2026-11-20T17:00:00.000Z', SCH)).toBe('2026-11-20T19:00:00.000Z');
    expect(IN.taskDueAt('cold', NOW, SCH)).toBe('2026-11-21T10:00:00.000Z');
  });
});

describe('crm', () => {
  const lead = { id: 'recL1', lead_id: 7, email: 'T.Becker@x.example', contact_name: 'Thomas Becker', company_name: 'Glanzwerk', domain: 'x.example', status: 'Meeting booked' };
  test('payloads', () => {
    expect(CRM.contactProps(lead).properties).toMatchObject({ email: 't.becker@x.example', firstname: 'Thomas', lastname: 'Becker' });
    expect(CRM.contactProps(lead).properties.lifecyclestage).toBeUndefined();
    expect(CRM.contactProps(lead, { create: true }).properties.lifecyclestage).toBe('lead');
    expect(Object.keys(CRM.contactProps(lead).properties).every((k) => !k.startsWith('nexsale'))).toBe(true);
    expect(CRM.companyProps(lead).properties.domain).toBe('x.example');
    const d = CRM.dealProps(lead, { start_time: '2026-11-25T09:00:00Z' }, '123');
    expect(d.properties).toMatchObject({ dealname: 'Glanzwerk – Erstgespräch (lead 7)', dealstage: 'appointmentscheduled', hubspot_owner_id: '123' });
    expect(CRM.dealProps(Object.assign({}, lead, { status: 'No-show' })).properties.dealstage).toBe('closedlost');
    expect(CRM.dealProps(Object.assign({}, lead, { status: 'Meeting held' })).properties.dealstage).toBe('qualifiedtobuy');
    expect(CRM.dealProps({ domain: 'd', id: 'r', status: 'x' }).properties.dealstage).toBe('appointmentscheduled');
    expect(CRM.contactSearch('A@b.de').filterGroups[0].filters[0].value).toBe('a@b.de');
    expect(CRM.companySearch('B.de').filterGroups[0].filters[0].value).toBe('b.de');
    expect(CRM.dealSearch('n').filterGroups[0].filters[0].value).toBe('n');
    expect(CRM.noteProps('s', '2026-01-01T00:00:00Z').properties.hs_timestamp).toBe('2026-01-01T00:00:00.000Z');
    expect(CRM.noteProps('s', null, 77).associations[0]).toMatchObject({ to: { id: '77' }, types: [{ associationTypeId: 214 }] });
  });
  test('names', () => {
    expect(CRM.splitName('Anna Maria Weber')).toEqual({ firstname: 'Anna Maria', lastname: 'Weber' });
    expect(CRM.splitName('Weber')).toEqual({ firstname: '', lastname: 'Weber' });
    expect(CRM.splitName('')).toEqual({ firstname: '', lastname: '' });
  });
  test('idempotent upsert: existing id -> PATCH, none -> POST', () => {
    expect(CRM.firstResultId({ results: [{ id: 42 }] })).toBe('42');
    expect(CRM.firstResultId({ results: [] })).toBeNull();
    expect(CRM.firstResultId(null)).toBeNull();
    expect(CRM.upsertPlan('42', 'contacts', {})).toMatchObject({ method: 'PATCH', path: '/crm/v3/objects/contacts/42' });
    expect(CRM.upsertPlan(null, 'deals', {})).toMatchObject({ method: 'POST', path: '/crm/v3/objects/deals' });
  });
});

describe('airtable', () => {
  test('batches of 10', () => {
    const b = AT.createBatches(Array.from({ length: 23 }, (_, i) => ({ n: i, skip: undefined })));
    expect(b.map((x) => x.records.length)).toEqual([10, 10, 3]);
    expect(b[0].records[0]).toEqual({ fields: { n: 0 } });
    expect(b[0].typecast).toBe(true);
    expect(AT.updateBatches([{ id: 'r1', fields: { a: 1 } }, { fields: {} }, null])).toEqual([{ records: [{ id: 'r1', fields: { a: 1 } }], typecast: true }]);
    expect(AT.createBatches(null)).toEqual([]);
    expect(AT.chunk([1, 2, 3], 2)).toEqual([[1, 2], [3]]);
  });
  test('formulas', () => {
    expect(AT.eq('status', "O'Brien")).toBe("{status}='O\\'Brien'");
    expect(AT.eq('n', 5)).toBe('{n}=5');
    expect(AT.eq('b', true)).toBe('{b}=TRUE()');
    expect(AT.eq('b', false)).toBe('{b}=FALSE()');
    expect(AT.and(AT.eq('a', 'x'), null, AT.eq('b', 'y'))).toBe("AND({a}='x',{b}='y')");
    expect(AT.and(AT.eq('a', 'x'))).toBe("{a}='x'");
    expect(AT.or('A', 'B')).toBe('OR(A,B)');
    expect(AT.or('A')).toBe('A');
  });
  test('fromItems and inIds', () => {
    expect(AT.fromItems([{ json: { records: [{ id: 'a', fields: { x: 1 } }] } }, { json: { records: [{ id: 'b', fields: {} }] } }, { json: {} }]).map((r) => r.id)).toEqual(['a', 'b']);
    expect(AT.fromItems(null)).toEqual([]);
    expect(() => AT.fromItems([{ json: { error: { type: 'RATE_LIMIT', message: 'forced 429' } } }])).toThrow(/Airtable read failed after retries: forced 429/);
    expect(() => AT.fromItems([{ json: { error: 'NOT_FOUND' } }])).toThrow(/NOT_FOUND/);
    expect(AT.inIds('lead_record_id', ['r1', 'r2', 'r1'])).toBe("OR({lead_record_id}='r1',{lead_record_id}='r2')");
    expect(AT.inIds('lead_record_id', [])).toBe("{lead_record_id}='__none__'");
  });
  test('flatten', () => {
    expect(AT.flatList({ records: [{ id: 'r', createdTime: 't', fields: { a: 1 } }] })).toEqual([{ id: 'r', createdTime: 't', a: 1 }]);
    expect(AT.flatList(null)).toEqual([]);
    expect(AT.flat(null)).toBeNull();
    expect(AT.flat({ id: 'x' })).toEqual({ id: 'x', createdTime: undefined });
  });
});

describe('calendly', () => {
  test('invitee.created', () => {
    const p = CAL.parseCalendly(created);
    expect(p).toMatchObject({ event: 'invitee.created', calendly_event_id: 'EVT-DEMO-0001', start_time: '2026-11-25T09:00:00.000000Z', valid: true });
    expect(CAL.meetingAction(p, [])).toEqual({ action: 'create' });
  });
  test('the same webhook twice -> one meeting', () => {
    const p = CAL.parseCalendly({ body: created });
    expect(CAL.meetingAction(p, [{ calendly_event_id: 'EVT-DEMO-0001', status: 'Booked' }]).action).toBe('skip');
  });
  test('invitee.canceled', () => {
    const p = CAL.parseCalendly(canceled);
    expect(p.cancel_reason).toBe('Terminkonflikt');
    expect(CAL.meetingAction(p, [{ calendly_event_id: 'EVT-DEMO-0001', status: 'Booked' }]).action).toBe('cancel');
    expect(CAL.meetingAction(p, [{ calendly_event_id: 'EVT-DEMO-0001', status: 'Cancelled' }]).action).toBe('skip');
    expect(CAL.meetingAction(p, []).reason).toBe('unknown meeting');
  });
  test('booking link carries the lead id; utm_content is parsed back', () => {
    expect(CAL.bookingLink('https://calendly.com/x/15min', 'recL1')).toBe('https://calendly.com/x/15min?utm_source=nexsale&utm_content=recL1');
    expect(CAL.bookingLink('https://calendly.com/x?a=1', 'r')).toMatch(/\?a=1&utm_source/);
    expect(CAL.bookingLink('', 'r')).toBe('');
    expect(CAL.parseCalendly({ event: 'invitee.created', payload: { email: 'a@b.de', tracking: { utm_content: 'recL1' } } }).utm_content).toBe('recL1');
  });
  test('webhook signature', () => {
    const crypto = require('crypto');
    const body = JSON.stringify(created);
    const t = 1763110000;
    const v1 = crypto.createHmac('sha256', 'key').update(t + '.' + body).digest('hex');
    expect(CAL.verifyCalendlySignature({ signingKey: 'key', header: 't=' + t + ',v1=' + v1, rawBody: body, crypto, now: t }).ok).toBe(true);
    expect(CAL.verifyCalendlySignature({ signingKey: 'key', header: 't=' + t + ',v1=' + v1, rawBody: body + ' ', crypto, now: t }).reason).toBe('signature mismatch');
    expect(CAL.verifyCalendlySignature({ signingKey: 'key', header: 't=' + t + ',v1=abc', rawBody: body, crypto, now: t }).ok).toBe(false);
    expect(CAL.verifyCalendlySignature({ signingKey: 'key', header: 't=' + t + ',v1=' + v1, rawBody: body, crypto, now: t + 999 }).reason).toBe('signature too old');
    expect(CAL.verifyCalendlySignature({ signingKey: 'key', header: '', crypto }).reason).toBe('missing signature');
    expect(CAL.verifyCalendlySignature({ crypto }).skipped).toBe(true);
    expect(CAL.verifyCalendlySignature({ signingKey: 'key', header: 't=' + Math.floor(Date.now() / 1000) + ',v1=x', crypto }).ok).toBe(false);
  });
  test('free plan: polled bookings become webhook-shaped payloads (new + cancelled, within the window)', () => {
    const now = '2026-11-20T10:00:00.000Z';
    const ev = (id, status) => ({ uri: 'https://api.calendly.com/scheduled_events/' + id, name: 'Erstgespräch', status, start_time: '2026-11-25T09:00:00Z', end_time: '2026-11-25T09:15:00Z' });
    const inv = (id, extra) => Object.assign({ uri: 'inv/' + id, email: 'p@t.test', name: 'P', status: 'active', created_at: '2026-11-20T09:55:00Z', tracking: { utm_content: 'recL1' } }, extra);
    const events = [ev('E1', 'active'), ev('E2', 'canceled'), ev('E3', 'active'), ev('E4', 'active')];
    const invitees = {
      [events[0].uri]: [inv('a')],
      [events[1].uri]: [inv('b', { status: 'canceled', created_at: '2026-11-19T09:00:00Z', updated_at: '2026-11-20T09:58:00Z', cancellation: { reason: 'x' } })],
      [events[2].uri]: [inv('c', { created_at: '2026-11-19T09:00:00Z' })], // old booking: already handled
    };
    const out = CAL.pollToPayloads(events, invitees, now, 30);
    expect(out.map((o) => o.event)).toEqual(['invitee.created', 'invitee.canceled']);
    const p = CAL.parseCalendly(out[0]);
    expect(p).toMatchObject({ valid: true, calendly_event_id: 'E1', utm_content: 'recL1', start_time: '2026-11-25T09:00:00Z' });
    expect(CAL.parseCalendly(out[1]).cancel_reason).toBe('x');
    expect(CAL.pollToPayloads(null, null).length).toBe(0);
    expect(CAL.pollToPayloads([events[0]], { [events[0].uri]: [inv('d', { created_at: new Date().toISOString() })] }).length).toBe(1);
  });
  test('invalid', () => {
    const p = CAL.parseCalendly({ event: 'routing_form_submission.created', payload: {} });
    expect(p.valid).toBe(false);
    expect(CAL.meetingAction(p, []).action).toBe('skip');
    expect(CAL.parseCalendly(null).valid).toBe(false);
  });
});

describe('reminders', () => {
  const meetings = [
    { id: 'M1', status: 'Booked', start_time: '2026-11-21T09:00:00Z' },
    { id: 'M2', status: 'Booked', start_time: '2026-11-23T09:00:00Z' },
    { id: 'M3', status: 'Reminded', start_time: '2026-11-20T09:30:00Z' },
    { id: 'M4', status: 'Held', start_time: '2026-11-20T08:00:00Z' },
    { id: 'M5', status: 'Booked', start_time: '2026-11-21T09:00:00Z', reminder_sent_at: 'x' },
    { id: 'M6', status: 'Booked' },
  ];
  test('24 h reminders and held/no-show checks 15 min after start', () => {
    const r = REM.dueReminders(meetings, NOW);
    expect(r.reminders.map((m) => m.id)).toEqual(['M1']);
    expect(r.heldChecks.map((m) => m.id)).toEqual(['M3']);
    expect(REM.dueReminders(null).reminders).toEqual([]);
  });
  test('reminder email', () => {
    const e = REM.reminderEmail(meetings[0], { email: 'a@b.de', contact_name: 'Herr Becker' }, { sender_name: 'Anna' }, REM.formatBerlin('2026-11-21T09:00:00Z'));
    expect(e.body).toMatch(/Samstag, 21. November 2026 um 10:00 Uhr/);
    expect(e.body).toMatch(/Anna$/);
    expect(REM.reminderEmail({}, { email: 'a@b.de' }).body).toMatch(/^Guten Tag,/);
  });
});

describe('gdpr deletion', () => {
  test('deletes lead with emails, replies, meetings, tasks; keeps a blocklist entry', () => {
    const p = GD.deletionPlan('A@x.de', { leads: [{ id: 'L1', email: 'a@x.de' }, { id: 'L2', email: 'b@x.de' }], emails: [{ id: 'E1', lead: ['L1'] }, { id: 'E2', lead: ['L2'] }], replies: [{ id: 'R1', lead: 'L1' }], meetings: [], tasks: [{ id: 'T1', lead: ['L1'] }] });
    expect(p.delete).toEqual({ Leads: ['L1'], Emails: ['E1'], Replies: ['R1'], Meetings: [], Tasks: ['T1'], Logs: [] });
    expect(p.blocklist).toMatchObject({ value: 'a@x.de', reason: 'GDPR deletion request' });
  });
  test('already blocked, invalid email', () => {
    expect(GD.deletionPlan('a@x.de', { blocklist: [{ value: 'a@x.de' }] }).blocklist).toBeNull();
    expect(GD.deletionPlan('nope', {}).ok).toBe(false);
  });
});

describe('slack messages', () => {
  test('campaign ready has the Approve and launch button and 3 samples', () => {
    const m = SM.campaignReady({ name: 'C', leadCount: 8, avgScore: 80, avgQuality: 88, flagged: 1, rejected: 2, campaignRecordId: 'recC', listUrl: 'https://airtable.com/x', samples: [1, 2, 3, 4].map((i) => ({ company: 'F' + i, score: 80, quality: 90, subject: 'S', body: 'B' })) });
    const actions = m.blocks.find((b) => b.type === 'actions');
    expect(actions.elements[0]).toMatchObject({ action_id: 'approve_launch', value: 'approve_launch|recC', style: 'primary' });
    expect(actions.elements[1].url).toBe('https://airtable.com/x');
    expect(m.blocks.filter((b) => b.type === 'divider')).toHaveLength(3);
    expect(JSON.stringify(m)).toMatch(/1 lead\(s\) held for review/);
    expect(SM.campaignReady({ name: 'C', campaignRecordId: 'r' }).blocks.find((b) => b.type === 'actions').elements).toHaveLength(1);
  });
  test('interested approval, sort reply, inbound, held/no-show', () => {
    expect(SM.interestedApproval({ company: 'F', replyRecordId: 'R1', replyBody: 'a\nb', suggestedReply: 'x' }).blocks[2].elements.map((e) => e.action_id)).toEqual(['reply_approve', 'reply_edit', 'reply_reject']);
    expect(SM.sortReply({ company: 'F', replyRecordId: 'R1', replyBody: 'x' }).blocks[1].elements.map((e) => e.value)).toEqual(['sort_interested|R1', 'sort_later|R1', 'sort_not_interested|R1', 'sort_unsubscribe|R1']);
    expect(SM.inboundLead({ temperature: 'hot', name: 'A', company: 'B', taskRecordId: 'T1', brief: 'b' }).text).toMatch(/hot/);
    expect(SM.heldOrNoShow({ company: 'F', meetingRecordId: 'M1' }).blocks[1].elements[1].action_id).toBe('meeting_noshow');
  });
  test('resolved message removes buttons and shows who clicked', () => {
    const r = SM.resolvedMessage({ blocks: [SM.section('x'), { type: 'actions', elements: [] }] }, 'Approved', 'demo.user', '10:00');
    expect(r.blocks.map((b) => b.type)).toEqual(['section', 'context']);
    expect(r.text).toBe('Approved by demo.user');
    expect(SM.resolvedMessage(null, 'A', 'u', 't').blocks).toHaveLength(1);
  });
  test('parseActionValue and long text truncation', () => {
    expect(SM.parseActionValue('reply_approve|rec1')).toEqual({ action: 'reply_approve', recordId: 'rec1' });
    expect(SM.parseActionValue(undefined)).toEqual({ action: '', recordId: undefined });
    expect(SM.section('x'.repeat(5000)).text.text).toHaveLength(2900);
  });
});

test('Campaign ready names the client and the sender (client campaigns vs own outreach)', () => {
  const SM2 = require('../slackMessages');
  const m = SM2.campaignReady({ name: 'Hausverwaltungen Berlin', campaignRecordId: 'r', leadCount: 5, client: 'Real Service GmbH', sender: 'Laura Schmidt, Real Service GmbH' });
  expect(m.blocks[0].text.text).toMatch(/For \*Real Service GmbH\* · sender Laura Schmidt, Real Service GmbH/);
  expect(SM2.campaignReady({ name: 'X', campaignRecordId: 'r' }).blocks[0].text.text).not.toMatch(/For \*/);
});
