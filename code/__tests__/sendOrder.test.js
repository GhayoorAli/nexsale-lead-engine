const S = require('../sending');
const G = require('../guard');
const CC = require('../controlCenter');

const T0 = new Date('2026-11-15T22:23:29Z').getTime();
const at = (min) => new Date(T0 + min * 60000).toISOString();
const camp = { id: 'C1', status: 'Live', daily_limit: 40 };
function lead(i, step, dueMin, extra) {
  return Object.assign({ id: 'L' + String(i).padStart(3, '0'), campaign_record_id: 'C1', status: step === 1 ? 'Approved' : 'Contacted', sequence_step: step, next_send_at: at(dueMin), email: `p${i}@firma${i}.example` }, extra || {});
}
function emailsFor(l, sentUpTo) {
  return [1, 2, 3, 4].map((n) => ({ id: l.id + '-' + n, lead_record_id: l.id, campaign_record_id: 'C1', step: n, status: n <= sentUpTo ? 'Sent' : 'Approved', sent_at: n <= sentUpTo ? at(1) : undefined }));
}

describe('send order: every lead gets email 1 before any follow-up, longest waiting first', () => {
  test('the live case: Helpling due since launch, follow-ups of early leads due too → Helpling goes first, follow-ups only after all first emails', () => {
    // listed LAST by Airtable (it was), but due earliest
    const helpling = lead(999, 1, 0, { company_name: 'Helpling' });
    const followUps = Array.from({ length: 16 }, (_, i) => lead(i, 2, 4.5 + i * 0.05));
    const firsts = Array.from({ length: 8 }, (_, i) => lead(100 + i, 1, 0.5));
    const leads = [...followUps, ...firsts, helpling];
    const emails = [...followUps.flatMap((l) => emailsFor(l, 1)), ...firsts.flatMap((l) => emailsFor(l, 0)), ...emailsFor(helpling, 0)];
    const r = S.selectDue({ leads, campaigns: [camp], emails, now: at(5), isBlocked: G.isBlocked, maxPerRun: 10, demoMode: true });
    expect(r.due[0].lead.id).toBe('L999');
    expect(r.due.slice(0, 9).every((d) => Number(d.email.step) === 1)).toBe(true); // all 9 first emails before any follow-up
    expect(Number(r.due[9].email.step)).toBe(2); // the 10th slot: the follow-up waiting longest
    expect(r.due[9].lead.id).toBe('L000');
  });
  test('a round full of first emails sends no follow-up at all', () => {
    const firsts = Array.from({ length: 12 }, (_, i) => lead(i, 1, i));
    const fu = lead(50, 2, -30);
    const r = S.selectDue({ leads: [fu, ...firsts], campaigns: [camp], emails: [...firsts.flatMap((l) => emailsFor(l, 0)), ...emailsFor(fu, 1)], now: at(60), isBlocked: G.isBlocked, maxPerRun: 10, demoMode: true });
    expect(r.due.map((d) => Number(d.email.step))).toEqual(Array(10).fill(1));
    expect(r.due.map((d) => d.lead.id)).toEqual(firsts.slice(0, 10).map((l) => l.id)); // oldest due first
    expect(r.skipped.find((x) => x.leadId === 'L050').reason).toMatch(/per-run cap/);
  });
  test('200 leads in test mode: every lead gets email 1 in the first rounds, nobody is skipped', () => {
    const leads = Array.from({ length: 200 }, (_, i) => lead(i, 1, 0));
    let emails = leads.flatMap((l) => emailsFor(l, 0));
    const got = new Set();
    for (let round = 0; round < 20; round += 1) {
      const sentToday = { C1: emails.filter((e) => e.status === 'Sent').length };
      const r = S.selectDue({ leads, campaigns: [camp], emails, now: at(1 + round), isBlocked: G.isBlocked, maxPerRun: 10, demoMode: true, sentTodayByCampaign: sentToday });
      r.due.forEach((d) => { got.add(d.lead.id); emails = emails.map((e) => (e.id === d.email.id ? Object.assign({}, e, { status: 'Sent', sent_at: at(1) }) : e)); d.lead.sequence_step = 2; d.lead.next_send_at = at(1000); d.lead.status = 'Contacted'; });
    }
    expect(got.size).toBe(200);
  });
  test('daily limit: real mode stays at 40; test mode is sized to the campaign (leads × 4)', () => {
    expect(S.dailyLimit({ daily_limit: 40 }, 25, false)).toBe(40);
    expect(S.dailyLimit({ daily_limit: 40 }, 25, true)).toBe(100);
    expect(S.dailyLimit({}, 5, true)).toBe(40);
    // the live case: 24 first + 16 follow-ups sent today = 40 → real mode stops, test mode continues
    const l = lead(1, 2, 0);
    const base = { leads: [l], campaigns: [camp], emails: emailsFor(l, 1).concat(Array.from({ length: 24 }, (_, i) => ({ id: 'x' + i, lead_record_id: 'Z' + i, campaign_record_id: 'C1', step: 1, status: 'Sent', sent_at: at(1) }))),
      now: at(10), isBlocked: G.isBlocked, sentTodayByCampaign: { C1: 40 } };
    expect(S.selectDue(Object.assign({}, base, { demoMode: false })).skipped[0].reason).toBe('daily limit reached');
    expect(S.selectDue(Object.assign({}, base, { demoMode: true })).due).toHaveLength(1);
  });
});

describe('campaign page shows sending progress and a reached daily limit', () => {
  const now = '2026-11-15T22:40:00Z';
  const data = (sentCount) => {
    const leads = Array.from({ length: 25 }, (_, i) => ({ id: 'L' + i, campaign: ['C1'], campaign_record_id: 'C1', status: i < 24 ? 'Contacted' : 'Approved', company_name: 'F' + i }));
    const emails = leads.flatMap((l, i) => [1, 2, 3, 4].map((n) => ({ id: l.id + n, lead: [l.id], lead_record_id: l.id, campaign_record_id: 'C1', step: n,
      status: (n === 1 && i < 24) || (n === 2 && i < sentCount - 24) ? 'Sent' : 'Approved', sent_at: '2026-11-15T22:30:00Z' })));
    return { clients: [{ id: 'k', name: 'K' }], campaigns: [{ id: 'C1', name: 'Reinigung Berlin', client: ['k'], client_record_id: 'k', status: 'Live', daily_limit: 40 }], leads, emails, replies: [], meetings: [], tasks: [], logs: [] };
  };
  const page = (demoMode, sent) => CC.renderPage({ page: 'campaign', params: { id: 'C1' }, data: data(sent), cfg: { demoMode }, now, user: 'a' });
  test('first emails 24 of 25, follow-ups, today x of limit', () => {
    const h = page(true, 40);
    expect(h).toMatch(/Erst-E-Mails <b>24 von 25<\/b> gesendet – alle Erst-E-Mails gehen vor jedem Follow-up raus · Follow-ups gesendet: 16 · heute 40 von 100/);
    expect(h).not.toMatch(/Tageslimit erreicht/);
  });
  test('real mode: limit reached is shown', () => {
    expect(page(false, 40)).toMatch(/Tageslimit erreicht \(40 E-Mails\) – der Versand geht morgen ab 08:00 weiter/);
  });
});
