const L = require('../launchChecks');
const S = require('../sending');
const G = require('../guard');
const SCH = require('../schedule');

const mkLead = (i, extra) => Object.assign({ id: 'L' + i, status: 'Approved', email: `p${i}@firma${i}.example`, domain: `firma${i}.example`, company_name: 'Firma ' + i, campaign: ['C1'] }, extra);
const mkEmails = (leadId, q) => [1, 2, 3, 4].map((s) => ({ id: `${leadId}-E${s}`, lead: [leadId], step: s, approved: true, quality_score: q === undefined ? 90 : q, status: 'Approved', subject: 'Betreff ' + s, subject_b: s === 1 ? 'Alt ' : '', body: 'Text ' + s }));

describe('pre-launch checks', () => {
  const leads = [1, 2, 3, 4, 5].map((i) => mkLead(i));
  const emails = leads.flatMap((l) => mkEmails(l.id));
  const base = { campaign: { name: 'X' }, leads, emails, blocklist: [], otherLiveContactedDomains: [], gmailOk: true, testMode: true, isBlocked: G.isBlocked };
  test('all pass with 5 approved leads in test mode', () => expect(L.runPrelaunchChecks(base).ok).toBe(true));
  test('real mode needs 20', () => expect(L.runPrelaunchChecks(Object.assign({}, base, { testMode: false })).failures[0].check).toMatch(/20/));
  test('each failing check is listed with a count', () => {
    const r = L.runPrelaunchChecks(Object.assign({}, base, {
      leads: leads.slice(0, 4).concat([mkLead(9, { status: 'Drafted' })]),
      emails: emails.map((e) => (e.lead[0] === 'L1' && e.step === 2 ? Object.assign({}, e, { quality_score: 70 }) : e)),
      blocklist: [{ value: 'firma2.example' }],
      otherLiveContactedDomains: ['firma3.example'],
      gmailOk: false,
    }));
    expect(r.ok).toBe(false);
    expect(r.failures.map((f) => [f.check, f.count])).toEqual([
      ['At least 5 Approved leads', 4],
      ['Every sequence passed the AI quality check', 1],
      ['No lead on the Blocklist', 1],
      ['No lead contacted in another Live campaign', 1],
      ['Gmail credential works', 1],
    ]);
    expect(L.failureText('X', r.failures)).toMatch(/5 check\(s\) failed[\s\S]*back to Ready/);
  });
  test('missing emails count as failed quality', () => {
    expect(L.runPrelaunchChecks(Object.assign({}, base, { emails: [] })).failures[0].count).toBe(5);
  });
  test('launch plan alternates subject A/B', () => {
    const p = L.buildLaunchPlan(leads.slice(0, 3), '2026-11-16T09:00:00.000Z');
    expect(p.map((x) => x.fields.subject_variant)).toEqual(['A', 'B', 'A']);
    expect(p[0].fields).toMatchObject({ sequence_step: 1, next_send_at: '2026-11-16T09:00:00.000Z' });
  });
});

describe('sending selection', () => {
  const now = '2026-11-16T09:00:00.000Z';
  const campaigns = [{ id: 'C1', status: 'Live', daily_limit: 2 }, { id: 'C2', status: 'Paused' }];
  const due = { sequence_step: 1, next_send_at: '2026-11-16T08:59:00.000Z' };
  test('picks due leads in Live campaigns only and respects the daily limit', () => {
    const leads = [mkLead(1, due), mkLead(2, due), mkLead(3, due), mkLead(4, Object.assign({}, due, { campaign: ['C2'] })), mkLead(5, { sequence_step: 1, next_send_at: '2026-11-16T10:00:00.000Z' })];
    const r = S.selectDue({ leads, campaigns, emails: leads.flatMap((l) => mkEmails(l.id)), now, isBlocked: G.isBlocked, sentTodayByCampaign: {} });
    expect(r.due.map((d) => d.lead.id)).toEqual(['L1', 'L2']);
    expect(r.skipped).toEqual([{ leadId: 'L3', reason: 'daily limit reached' }]);
  });
  test('no email after a reply, nothing to blocked addresses, nothing without an approved email', () => {
    const leads = [mkLead(1, due), mkLead(2, due), mkLead(3, due), mkLead(6, Object.assign({}, due, { status: 'Replied' })), mkLead(7, Object.assign({}, due, { sequence_finished: true })), mkLead(8, { sequence_step: 0 })];
    const r = S.selectDue({ leads, campaigns: [{ id: 'C1', status: 'Live' }], emails: mkEmails('L1').concat(mkEmails('L2')), replies: [{ lead: ['L1'] }], blocklist: [{ value: 'p2@firma2.example' }], now, isBlocked: G.isBlocked });
    expect(r.due).toHaveLength(0);
    expect(r.skipped.map((s) => s.reason)).toEqual(['lead has replied', 'on blocklist', 'no approved email for step 1']);
  });
  test('buildMessage: step 1 subject A/B, later steps reply in thread', () => {
    const l = mkLead(1, { subject_variant: 'B' });
    const es = mkEmails('L1');
    expect(S.buildMessage({ lead: l, email: es[0] }, { senderEmail: 's@x' }, { sender_name: 'Anna' })).toMatchObject({ to: l.email, subject: 'Alt', fromName: 'Anna', threadId: '', step: 1 });
    const prev = Object.assign({}, es[0], { status: 'Sent', thread_id: 'T1', subject_sent: '[TEST] Betreff 1' });
    const m = S.buildMessage({ lead: mkLead(1), email: es[1], prevEmail: prev }, { senderEmail: 's@x' });
    expect(m).toMatchObject({ subject: 'Re: Betreff 1', threadId: 'T1' });
    const m3 = S.buildMessage({ lead: mkLead(1), email: es[2], prevEmail: Object.assign({}, prev, { subject_sent: 'Re: Re: X' }) }, {});
    expect(m3.subject).toBe('Re: X');
    expect(S.buildMessage({ lead: mkLead(1), email: es[1] }, {}).subject).toBe('Re: Betreff 2');
  });
  test('afterSend advances steps on the day 0/3/7/14 schedule and finishes after step 4', () => {
    const es = mkEmails('L1');
    const opts = { demoMode: true };
    const a1 = S.afterSend({ lead: mkLead(1), email: es[0] }, { id: 'g1', threadId: 'T1', subject: '[TEST] Betreff 1' }, now, SCH, opts);
    expect(a1.lead.fields).toMatchObject({ status: 'Contacted', sequence_step: 2, first_sent_at: now, next_send_at: '2026-11-16T09:03:00.000Z' });
    expect(a1.email.fields).toMatchObject({ status: 'Sent', gmail_message_id: 'g1', thread_id: 'T1' });
    const a3 = S.afterSend({ lead: mkLead(1, { first_sent_at: now }), email: es[2] }, {}, '2026-11-16T09:07:10.000Z', SCH, opts);
    expect(a3.lead.fields.next_send_at).toBe('2026-11-16T09:14:00.000Z');
    const a4 = S.afterSend({ lead: mkLead(1, { first_sent_at: now }), email: es[3] }, {}, now, SCH, opts);
    expect(a4.lead.fields).toMatchObject({ sequence_finished: true, next_send_at: null, sequence_step: 4 });
  });
  test('per-run cap keeps one run shorter than the tick interval', () => {
    const leads = [1, 2, 3].map((i) => mkLead(i, due));
    const r = S.selectDue({ leads, campaigns: [{ id: 'C1', status: 'Live' }], emails: leads.flatMap((l) => mkEmails(l.id)), now, isBlocked: G.isBlocked, maxPerRun: 2 });
    expect(r.due).toHaveLength(2);
    expect(r.skipped[0].reason).toMatch(/per-run cap/);
  });
  test('bounce check pauses above 3%', () => {
    expect(S.bounceCheck(100, 3)).toEqual({ rate: 0.03, pause: false });
    expect(S.bounceCheck(100, 4)).toEqual({ rate: 0.04, pause: true });
    expect(S.bounceCheck(0, 0)).toEqual({ rate: 0, pause: false });
    expect(S.bounceCheck(10, 1, 0.2).pause).toBe(false);
  });
  test('linkId', () => expect(S.linkId(['a'])).toBe('a'));
});
