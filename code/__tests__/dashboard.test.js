const D = require('../dashboard');

const now = '2026-11-15T12:00:00.000Z'; // day 15 of 30 → ~47 % of the month elapsed
const clients = [{ id: 'cN', name: 'Nexsale GmbH', target_positive_replies: 20, target_meetings: 4 }, { id: 'cR', name: 'Real Service GmbH', target_positive_replies: 20, target_meetings: 4 }];
const campaigns = [
  { id: 'k1', name: 'Reinigungsfirmen Berlin', client: ['cN'], status: 'Live', created_at: '2026-11-10', google_api_cost_eur: 0.032, ai_cost_eur: 0.968 },
  { id: 'k2', name: 'Hausverwaltungen Berlin', client: ['cR'], status: 'Live', created_at: '2026-11-12', google_api_cost_eur: 0, ai_cost_eur: 0.5 },
];
const L = (id, camp, status, variant) => ({ id, campaign: [camp], campaign_record_id: camp, status, sourced_at: '2026-11-11', company_name: 'Firma ' + id, contact_name: 'P ' + id, subject_variant: variant });
const leads = [L('a', 'k1', 'Meeting booked', 'A'), L('b', 'k1', 'Contacted', 'B'), L('c', 'k1', 'Rejected'), L('d', 'k2', 'Interested', 'A')];
const E = (lead, step, extra) => Object.assign({ lead: [lead], lead_record_id: lead, step, status: 'Sent', sent_at: '2026-11-12', subject: 'Neue Kunden Pankow', subject_b: 'Pankow: neue Aufträge' }, extra);
const emails = [E('a', 1), E('a', 2), E('b', 1), E('d', 1)];
const replies = [
  { lead: ['a'], lead_record_id: 'a', category: 'Interested', received_at: '2026-11-13T09:00:00Z', summary: 'Will sprechen <b>' },
  { lead: ['d'], lead_record_id: 'd', category: 'Question', received_at: '2026-11-14T09:00:00Z', summary: 'Fragt nach Preis' },
];
const meetings = [{ lead: ['a'], lead_record_id: 'a', status: 'Booked', start_time: '2026-11-20T09:00:00Z' }, { lead: ['a'], lead_record_id: 'a', status: 'Cancelled', start_time: '2026-11-21T09:00:00Z' }];
const input = { clients, campaigns, leads, emails, replies, meetings, now };

test('totals across all clients', () => {
  const d = D.dashboardData(input);
  expect(d.totals).toMatchObject({ leads_sourced: 4, emails_sent: 4, contacted: 3, replied: 2, positive_replies: 2, meetings_booked: 1 });
  expect(d.totals.reply_rate_pct).toBe(66.7);
  expect(d.totals.cost_per_meeting_eur).toBeCloseTo(1.5, 5);
  expect(d.rows.map((r) => r.name)).toEqual(['Hausverwaltungen Berlin', 'Reinigungsfirmen Berlin']);
});

test('client filter shows only that client', () => {
  const d = D.dashboardData(Object.assign({ clientId: 'cR' }, input));
  expect(d.rows.map((r) => r.name)).toEqual(['Hausverwaltungen Berlin']);
  expect(d.guarantees.map((g) => g.name)).toEqual(['Real Service GmbH']);
  expect(d.recent.map((r) => r.company)).toEqual(['Firma d']);
  expect(d.upcoming).toEqual([]);
});

test('guarantee pace: behind plan in the middle of the month with 1 of 20', () => {
  const g = D.dashboardData(input).guarantees.find((x) => x.name === 'Nexsale GmbH');
  expect(g.positive_replies).toBe(1);
  expect(g.replyPace.state).toBe('warning');
  expect(g.replyPace.label).toMatch(/hinter Plan \(Soll heute 10\)/);
  expect(D.pace(20, 20, now).label).toBe('Ziel erreicht');
  expect(D.pace(9, 20, now).state).toBe('good');
  expect(D.monthElapsed('2026-11-01T00:00:00Z')).toBe(0);
});

test('A/B subject test counts sent and replied first emails per variant; winner only from 20 sends each', () => {
  const ab = D.abTest(campaigns[0], input);
  expect(ab.A).toEqual({ sent: 1, replied: 1, rate: 100 });
  expect(ab.B).toEqual({ sent: 1, replied: 0, rate: 0 });
  expect(ab.winner).toBeNull();
  expect(ab.subject_b).toBe('Pankow: neue Aufträge');
  const many = { leads: [], emails: [], replies: [] };
  for (let i = 0; i < 40; i++) { const v = i % 2 ? 'B' : 'A'; many.leads.push(L('x' + i, 'k1', 'Contacted', v)); many.emails.push(E('x' + i, 1)); if (v === 'B' && i < 10) many.replies.push({ lead_record_id: 'x' + i, category: 'Interested' }); }
  expect(D.abTest(campaigns[0], many).winner).toBe('B');
});

test('renders a complete, escaped, responsive page', () => {
  const h = D.renderDashboard(input);
  expect(h).toMatch(/<title>Nexsale Dashboard<\/title>/);
  expect(h).toMatch(/http-equiv="refresh" content="60"/);
  expect(h).toMatch(/Garantie/);
  expect(h).toMatch(/hinter Plan/);
  expect(h).toMatch(/Kosten pro Termin/);
  expect(h).toMatch(/Will sprechen &lt;b&gt;/);
  expect(h).not.toMatch(/Will sprechen <b>/);
  expect(h).toMatch(/prefers-color-scheme:dark/);
  expect(h).toMatch(/max-width:700px/);
  expect(h).toMatch(/href="\?client=cR"/);
  expect(D.renderDashboard({ clients: [] })).toMatch(/Noch keine Kampagnen/);
  expect(D.esc(null)).toBe('');
});

test('money: small amounts keep 4 decimals (cost per lead), others 2', () => {
  expect(D.eur(0.000534)).toBe('0,0005 €');
  expect(D.eur(1.5)).toBe('1,50 €');
  expect(D.eur(0)).toBe('0,00 €');
  expect(D.eur(null)).toBe('–');
});
