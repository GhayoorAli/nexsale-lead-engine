/**
 * dashboard.js – the live dashboard (GET /webhook/dashboard[?client=<id>]), computed from Airtable on every load.
 * Per client: the guarantee (positive replies vs 20, meetings vs 4–5 this month, on track or behind for the day of the
 * month), the funnel, cost per lead and meeting, every campaign, the A/B subject test, recent replies, upcoming meetings.
 * Pure function: data in, escaped HTML out, so it is unit-tested without n8n. Uses report.js for the numbers.
 */
// in n8n the builder embeds report.js first as M.report; in Node (tests) it is required
function rep() {
  /* global M */
  if (typeof M !== 'undefined' && M.report) return M.report;
  return require('./report'); // eslint-disable-line global-require
}

function esc(s) {
  return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const link = (v) => (Array.isArray(v) ? v[0] : v);
// small amounts (cost per lead is ~0.001 €) keep their significant digits instead of rounding to 0,00 €
const eur = (n) => {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '–';
  const v = Number(n);
  const digits = v !== 0 && Math.abs(v) < 0.1 ? 4 : 2;
  return v.toLocaleString('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits }) + ' €';
};
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);

/** Share of the month already elapsed (Berlin time is close enough to UTC for a monthly pace). */
function monthElapsed(now) {
  const d = new Date(now);
  const days = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  return Math.min(1, (d.getUTCDate() - 1 + d.getUTCHours() / 24) / days);
}

/** On track when the target share reached is at least the share of the month elapsed (5 % grace). */
function pace(value, target, now) {
  const need = monthElapsed(now) * target;
  if (value >= target) return { state: 'good', label: 'Ziel erreicht', icon: '✓' };
  if (value + 0.05 * target >= need) return { state: 'good', label: 'im Plan', icon: '✓' };
  return { state: 'warning', label: 'hinter Plan (Soll heute ' + Math.ceil(need) + ')', icon: '!' };
}

/** A/B test of the first subject line: sent and replied leads per variant, winner once both have 20+ sends. */
function abTest(campaign, data) {
  const leads = (data.leads || []).filter((l) => l.campaign_record_id === campaign.id || link(l.campaign) === campaign.id);
  const byId = Object.fromEntries(leads.map((l) => [l.id, l]));
  const sent = (data.emails || []).filter((e) => byId[e.lead_record_id || link(e.lead)] && Number(e.step) === 1 && e.status === 'Sent');
  const replied = new Set((data.replies || []).filter((r) => r.category && r.category !== 'Bounce' && r.category !== 'Out of office').map((r) => r.lead_record_id || link(r.lead)));
  const v = { A: { sent: 0, replied: 0 }, B: { sent: 0, replied: 0 } };
  sent.forEach((e) => {
    const l = byId[e.lead_record_id || link(e.lead)];
    const k = l.subject_variant === 'B' ? 'B' : 'A';
    v[k].sent += 1;
    if (replied.has(l.id)) v[k].replied += 1;
  });
  ['A', 'B'].forEach((k) => { v[k].rate = pct(v[k].replied, v[k].sent); });
  const first = sent.find((e) => e.subject) || {};
  const b = sent.find((e) => e.subject_b) || {};
  const winner = v.A.sent >= 20 && v.B.sent >= 20 && v.A.rate !== v.B.rate ? (v.A.rate > v.B.rate ? 'A' : 'B') : null;
  return { subject_a: first.subject || '', subject_b: b.subject_b || '', A: v.A, B: v.B, winner };
}

function dashboardData(input) {
  const o = input || {};
  const now = o.now || Date.now();
  const data = { campaigns: o.campaigns || [], leads: o.leads || [], emails: o.emails || [], replies: o.replies || [], meetings: o.meetings || [] };
  const clients = (o.clients || []).filter((c) => !o.clientId || c.id === o.clientId);
  const ids = new Set(clients.map((c) => c.id));
  const campaigns = data.campaigns.filter((c) => ids.has(link(c.client) || c.client_record_id))
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  const rows = campaigns.map((c) => Object.assign(rep().campaignMetrics(c, data), { status: c.status, clientName: (clients.find((k) => k.id === (link(c.client) || c.client_record_id)) || {}).name, ab: abTest(c, data) }));
  const sum = (k) => rows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  const totals = { leads_sourced: sum('leads_sourced'), enriched: sum('enriched'), emails_sent: sum('emails_sent'), contacted: sum('contacted'), replied: sum('replied'),
    positive_replies: sum('positive_replies'), meetings_booked: sum('meetings_booked'), cost_eur: sum('cost_eur') };
  totals.reply_rate_pct = pct(totals.replied, totals.contacted);
  totals.cost_per_lead_eur = totals.leads_sourced ? totals.cost_eur / totals.leads_sourced : null;
  totals.cost_per_meeting_eur = totals.meetings_booked ? totals.cost_eur / totals.meetings_booked : null;
  const guarantees = clients.map((k) => {
    const g = rep().guaranteeTracker(k, Object.assign({}, data, { campaigns: data.campaigns.map((c) => Object.assign({}, c, { client: link(c.client) || c.client_record_id })) }), now);
    return Object.assign(g, { replyPace: pace(g.positive_replies, g.target_positive_replies, now), meetingPace: pace(g.meetings, g.target_meetings, now) });
  });
  const leadById = Object.fromEntries(data.leads.map((l) => [l.id, l]));
  const campIds = new Set(campaigns.map((c) => c.id));
  const inScope = (leadId) => { const l = leadById[leadId]; return l && campIds.has(l.campaign_record_id || link(l.campaign)); };
  const recent = data.replies.filter((r) => inScope(r.lead_record_id || link(r.lead))).sort((a, b) => String(b.received_at).localeCompare(String(a.received_at))).slice(0, 8)
    .map((r) => ({ when: r.received_at, company: (leadById[r.lead_record_id || link(r.lead)] || {}).company_name, category: r.category, summary: r.summary }));
  const upcoming = data.meetings.filter((m) => m.status !== 'Cancelled' && inScope(m.lead_record_id || link(m.lead)) && new Date(m.start_time).getTime() >= new Date(now).getTime() - 3600000)
    .sort((a, b) => String(a.start_time).localeCompare(String(b.start_time))).slice(0, 6)
    .map((m) => ({ when: m.start_time, company: (leadById[m.lead_record_id || link(m.lead)] || {}).company_name, contact: (leadById[m.lead_record_id || link(m.lead)] || {}).contact_name, status: m.status }));
  return { now, clients: o.clients || [], selected: o.clientId || '', rows, totals, guarantees, recent, upcoming };
}

const berlin = (iso) => (iso ? new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(iso)) : '');

function bar(value, max, label, title) {
  const w = max ? Math.max(value ? 2 : 0, Math.round((value / max) * 100)) : 0;
  return `<div class="bar" title="${esc(title || label)}"><span class="fill" style="width:${w}%"></span></div>`;
}

function renderDashboard(input) {
  const d = dashboardData(input);
  const t = d.totals;
  const tiles = [
    ['Positive Antworten', t.positive_replies, 'Interessiert oder konkrete Frage'],
    ['Termine gebucht', t.meetings_booked, 'über den Calendly-Link'],
    ['Antwortquote', t.reply_rate_pct + ' %', t.replied + ' von ' + t.contacted + ' kontaktierten Firmen'],
    ['E-Mails gesendet', t.emails_sent, 'inkl. Follow-ups'],
    ['Kosten pro Lead', eur(t.cost_per_lead_eur), 'Google + KI'],
    ['Kosten pro Termin', eur(t.cost_per_meeting_eur), 'Google + KI, ohne Personal'],
  ].map(([k, v, s]) => `<div class="tile"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div><div class="s">${esc(s)}</div></div>`).join('');
  const guarantee = d.guarantees.map((g) => `<div class="card"><h3>${esc(g.name)} · Garantie diesen Monat</h3>
    ${[['Positive Antworten', g.positive_replies, g.target_positive_replies, g.replyPace], ['Qualifizierte Termine', g.meetings, g.target_meetings, g.meetingPace]].map(([k, v, tg, p]) => `
    <div class="g"><div class="gl"><span>${esc(k)}</span><b>${esc(v)} / ${esc(tg)}</b></div>${bar(Math.min(v, tg), tg, k, k + ': ' + v + ' von ' + tg)}
    <div class="st ${p.state}"><span aria-hidden="true">${p.icon}</span> ${esc(p.label)}</div></div>`).join('')}</div>`).join('');
  const f = [['Gefunden (Google)', t.leads_sourced], ['Angereichert', t.enriched], ['Kontaktiert', t.contacted], ['Geantwortet', t.replied], ['Positiv', t.positive_replies], ['Termin', t.meetings_booked]];
  const funnel = f.map(([k, v], i) => `<div class="fr"><span class="fk">${esc(k)}</span>${bar(v, f[0][1], k, k + ': ' + v + (i ? ' (' + pct(v, f[i - 1][1]) + ' % der vorherigen Stufe)' : ''))}<span class="fv">${esc(v)}${i ? ' <small>' + pct(v, f[i - 1][1]) + ' %</small>' : ''}</span></div>`).join('');
  const rows = d.rows.map((r) => `<tr><td><b>${esc(r.name)}</b><br><small>${esc(r.clientName || '')} · ${esc(r.status || '')}</small></td><td>${r.leads_sourced}</td><td>${r.emails_sent}</td><td>${r.reply_rate_pct} %</td><td>${r.positive_replies}</td><td>${r.meetings_booked}</td><td>${eur(r.cost_eur)}</td><td>${eur(r.cost_per_meeting_eur)}</td></tr>`).join('')
    || '<tr><td colspan="8">Noch keine Kampagnen.</td></tr>';
  const ab = d.rows.filter((r) => r.ab.A.sent + r.ab.B.sent > 0).map((r) => `<tr><td>${esc(r.name)}</td><td>A: ${esc(r.ab.subject_a)}<br><small>${r.ab.A.replied}/${r.ab.A.sent} · ${r.ab.A.rate} %</small></td><td>B: ${esc(r.ab.subject_b || '–')}<br><small>${r.ab.B.replied}/${r.ab.B.sent} · ${r.ab.B.rate} %</small></td><td>${r.ab.winner ? '<b>' + r.ab.winner + '</b> gewinnt' : '<small>ab 20 Sendungen je Variante</small>'}</td></tr>`).join('')
    || '<tr><td colspan="4">Noch keine gesendeten Erst-E-Mails.</td></tr>';
  const recent = d.recent.map((r) => `<li><small>${esc(berlin(r.when))}</small> <b>${esc(r.company || '')}</b> <span class="tag">${esc(r.category || '')}</span><br>${esc(r.summary || '')}</li>`).join('') || '<li>Noch keine Antworten.</li>';
  const upcoming = d.upcoming.map((m) => `<li><b>${esc(berlin(m.when))}</b> · ${esc(m.company || '')}${m.contact ? ' (' + esc(m.contact) + ')' : ''}</li>`).join('') || '<li>Keine anstehenden Termine.</li>';
  const filter = [`<a href="?" class="${d.selected ? '' : 'on'}">Alle Clients</a>`].concat(d.clients.map((k) => `<a href="?client=${esc(k.id)}" class="${d.selected === k.id ? 'on' : ''}">${esc(k.name)}</a>`)).join('');
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="refresh" content="60">
<title>Nexsale Dashboard</title><style>
:root{--bg:#f7f7f5;--card:#fcfcfb;--text:#1b1b1a;--muted:#666660;--line:#e6e5e0;--accent:#2a78d6;--track:#e9eef6;--good:#0ca30c;--goodtext:#006300;--warn:#fab219;--warntext:#8a5a00}
@media (prefers-color-scheme:dark){:root{--bg:#121211;--card:#1a1a19;--text:#ecebe6;--muted:#a3a29b;--line:#2e2e2b;--accent:#3987e5;--track:#262a31;--good:#0ca30c;--goodtext:#5fd35f;--warn:#fab219;--warntext:#fab219}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:1100px;margin:0 auto;padding:20px 16px 40px}h1{font-size:20px;margin:0}h2{font-size:15px;margin:26px 0 10px}h3{font-size:14px;margin:0 0 10px}
.top{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:baseline;justify-content:space-between}.top small{color:var(--muted)}
.filter{display:flex;flex-wrap:wrap;gap:6px;margin:12px 0 4px}.filter a{padding:4px 10px;border:1px solid var(--line);border-radius:14px;color:var(--text);text-decoration:none}.filter a.on{border-color:var(--accent);color:var(--accent);font-weight:600}
.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px}.tile,.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.k{color:var(--muted);font-size:12px}.v{font-size:26px;font-weight:650;margin:2px 0}.s{color:var(--muted);font-size:12px}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:10px}.g{margin:8px 0 12px}.gl{display:flex;justify-content:space-between}
.bar{height:10px;background:var(--track);border-radius:5px;overflow:hidden;margin:4px 0}.fill{display:block;height:100%;background:var(--accent);border-radius:0 4px 4px 0}
.bar:hover .fill{filter:brightness(1.12)}.st{font-size:12px;font-weight:600}.st.good{color:var(--goodtext)}.st.warning{color:var(--warntext)}
.st span{display:inline-block;width:16px;height:16px;line-height:16px;text-align:center;border-radius:50%;color:#fff;font-size:11px}.st.good span{background:var(--good)}.st.warning span{background:var(--warn);color:#0b0b0b}
.fr{display:grid;grid-template-columns:150px 1fr 90px;gap:10px;align-items:center;margin:6px 0}.fk{color:var(--muted)}.fv{text-align:right;font-weight:600}.fv small{color:var(--muted);font-weight:400}
.tw{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:10px}table{width:100%;border-collapse:collapse;min-width:640px}th,td{text-align:left;padding:8px 10px;border-top:1px solid var(--line);vertical-align:top}th{border-top:0;color:var(--muted);font-weight:500;font-size:12px}td small{color:var(--muted)}
.two{display:grid;grid-template-columns:1fr 1fr;gap:10px}ul{list-style:none;margin:0;padding:0}li{padding:8px 0;border-top:1px solid var(--line)}li:first-child{border-top:0}
.tag{font-size:11px;border:1px solid var(--line);border-radius:10px;padding:0 6px;color:var(--muted)}
@media (max-width:700px){.two{grid-template-columns:1fr}.fr{grid-template-columns:110px 1fr 70px}.v{font-size:22px}}
</style></head><body><div class="wrap">
<div class="top"><h1>Nexsale · Dashboard</h1><small>Stand ${esc(berlin(new Date(d.now).toISOString()))} · aktualisiert sich jede Minute</small></div>
<nav class="filter" aria-label="Client">${filter}</nav>
<h2>Garantie</h2><div class="cards">${guarantee || '<div class="card">Keine Clients.</div>'}</div>
<h2>Kennzahlen (alle Kampagnen der Auswahl)</h2><div class="tiles">${tiles}</div>
<h2>Funnel</h2><div class="card">${funnel}</div>
<h2>Kampagnen</h2><div class="tw"><table><tr><th>Kampagne</th><th>Leads</th><th>E-Mails</th><th>Antwortquote</th><th>Positiv</th><th>Termine</th><th>Kosten</th><th>pro Termin</th></tr>${rows}</table></div>
<h2>A/B-Test Betreffzeile</h2><div class="tw"><table><tr><th>Kampagne</th><th>Variante A</th><th>Variante B</th><th>Ergebnis</th></tr>${ab}</table></div>
<div class="two"><div><h2>Neueste Antworten</h2><div class="card"><ul>${recent}</ul></div></div><div><h2>Anstehende Termine</h2><div class="card"><ul>${upcoming}</ul></div></div></div>
</div></body></html>`;
}

const dashboardApi = { eur, renderDashboard, dashboardData, abTest, pace, monthElapsed, esc };
if (typeof module !== 'undefined' && module.exports) module.exports = dashboardApi;
