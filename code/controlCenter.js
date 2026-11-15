/**
 * controlCenter.js – the Control Center: one password-protected web app (served by n8n, local only) that runs the
 * whole process: overview, clients (add/edit), campaigns (create, launch, pause/resume/stop), leads (review, exclude,
 * rewrite emails), replies (approve/edit/reject, sort), meetings (held/no-show), open tasks and system status.
 *
 * Pure functions: data in → escaped HTML out (renderPage), form in → planned operations out (planAction). n8n executes
 * the planned Airtable writes and webhook kicks. Slack actions and Control Center actions run the SAME workflow logic
 * (11_slack_actions via its internal "control-action" entry), so both always behave identically.
 */
/* global M */
function dep(name, file) {
  if (typeof M !== 'undefined' && M[name]) return M[name];
  return require(file); // eslint-disable-line global-require
}

function esc(s) {
  return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const link = (v) => (Array.isArray(v) ? v[0] : v);
const leadCamp = (l) => l.campaign_record_id || link(l.campaign);
const leadOf = (x) => x.lead_record_id || link(x.lead);
const campClient = (c) => c.client_record_id || link(c.client);
const berlin = (iso, withTime = true) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('de-DE', Object.assign({ timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: '2-digit' }, withTime ? { hour: '2-digit', minute: '2-digit' } : {})).format(d);
};
const q = (o) => Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
const href = (page, params) => '?' + q(Object.assign({ p: page }, params || {}));

/* Links open in the SAME tab: n8n serves webhook pages with a CSP sandbox, and a new tab (target=_blank) would inherit
   it – the n8n editor and Airtable cannot work inside that sandbox (live bug). Same-tab navigation leaves it. */

/* ------------------------------------------------------------------ auth */

/** HTTP Basic auth against CONTROL_USER / CONTROL_PASSWORD (constant-time). Empty password = locked. */
function checkAuth(header, user, password, crypto) {
  if (!password) return { ok: false, reason: 'CONTROL_PASSWORD is not set in .env' };
  const m = String(header || '').match(/^Basic\s+([A-Za-z0-9+/=]+)$/);
  if (!m) return { ok: false, reason: 'login required' };
  let decoded = '';
  try { decoded = Buffer.from(m[1], 'base64').toString('utf8'); } catch (e) { return { ok: false, reason: 'bad header' }; }
  const i = decoded.indexOf(':');
  const u = decoded.slice(0, i);
  const p = decoded.slice(i + 1);
  const same = (a, b) => {
    const A = Buffer.from(String(a));
    const B = Buffer.from(String(b));
    return A.length === B.length && (crypto ? crypto.timingSafeEqual(A, B) : A.equals(B));
  };
  const ok = i > 0 && same(u, user || 'admin') && same(p, password);
  return { ok, reason: ok ? '' : 'wrong user or password', user: ok ? u : '' };
}

/* ------------------------------------------------------------------ status helpers */

const STATUS_TONE = {
  Sourcing: 'info', Ready: 'warn', Launch: 'info', Live: 'good', Paused: 'warn', Completed: 'muted', Draft: 'muted',
  New: 'muted', Enriching: 'info', Enriched: 'info', Drafting: 'info', Approved: 'good', 'Needs review': 'warn', Rejected: 'muted',
  Contacted: 'info', Replied: 'info', Interested: 'good', Later: 'warn', 'Meeting booked': 'good', 'Meeting held': 'good',
  'No-show': 'bad', 'Not interested': 'muted', Unsubscribed: 'muted', Bounced: 'bad', Booked: 'good', Reminded: 'good', Held: 'good', Cancelled: 'muted',
  Sent: 'good', Draft_: 'muted', Skipped: 'muted', Open: 'warn', Done: 'muted',
};
const badge = (s) => `<span class="badge ${STATUS_TONE[s] || 'muted'}">${esc(s || '–')}</span>`;

function pendingApproval(replies) {
  return (replies || []).filter((r) => r.suggested_reply && r.reply_approved !== true && !r.handled_at);
}
function toSort(replies) {
  return (replies || []).filter((r) => r.branch === 'Unsure' && !r.handled_at && !r.suggested_reply);
}
/** An upcoming meeting that can still be cancelled (in Calendly too). */
function cancellable(m, now) {
  return !!m && (m.status === 'Booked' || m.status === 'Reminded') && new Date(m.start_time).getTime() > new Date(now).getTime();
}
function heldOpen(meetings, now) {
  const t = new Date(now).getTime();
  return (meetings || []).filter((m) => (m.status === 'Booked' || m.status === 'Reminded') && new Date(m.start_time).getTime() + 15 * 60000 <= t);
}

/* ------------------------------------------------------------------ layout */

function layout(o, title, body) {
  const d = o.data || {};
  const nApprove = pendingApproval(d.replies).length + toSort(d.replies).length;
  const nav = [['overview', 'Übersicht'], ['campaigns', 'Kampagnen'], ['new-campaign', '+ Neue Kampagne'], ['replies', 'Antworten' + (nApprove ? ` <b class="count">${nApprove}</b>` : '')],
    ['meetings', 'Termine'], ['clients', 'Clients'], ['system', 'System']]
    .map(([p, l]) => `<a href="${href(p)}" class="${o.page === p || (o.page === 'campaign' && p === 'campaigns') || (o.page === 'lead' && p === 'campaigns') || (o.page === 'client' && p === 'clients') ? 'on' : ''}">${l}</a>`).join('');
  const flash = o.params && o.params.msg ? `<div class="flash ${o.params.err ? 'bad' : 'good'}">${esc(o.params.msg)}</div>` : '';
  const demo = o.cfg && o.cfg.demoMode ? '<span class="badge good">Testmodus: alle E-Mails nur an die Test-Inbox</span>' : '<span class="badge bad">ECHTVERSAND AKTIV</span>';
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Nexsale Control Center</title><style>${CSS}</style></head><body>
<header><div class="brand">Nexsale <span>Control Center</span></div><div class="hdr">${demo}<small>${esc(o.user || '')}</small></div></header>
<div class="shell"><nav>${nav}<a href="/webhook/dashboard">Dashboard ↗</a></nav>
<main><h1>${esc(title)}</h1>${flash}${body}</main></div></body></html>`;
}

const CSS = `:root{--bg:#f6f6f4;--card:#fdfdfc;--text:#1b1b1a;--muted:#6a6a64;--line:#e5e4df;--accent:#2a78d6;--good:#0b7a2b;--goodbg:#e6f4ea;--warn:#8a5a00;--warnbg:#fff4d6;--bad:#b42318;--badbg:#fde8e7;--info:#1c5cab;--infobg:#e7f0fb}
@media (prefers-color-scheme:dark){:root{--bg:#121211;--card:#1b1b1a;--text:#ecebe6;--muted:#a3a29b;--line:#2f2f2c;--accent:#5598e7;--good:#5fd35f;--goodbg:#173520;--warn:#fab219;--warnbg:#3a2d0c;--bad:#ff8a80;--badbg:#3d1714;--info:#86b6ef;--infobg:#16263b}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
header{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px 16px;border-bottom:1px solid var(--line);background:var(--card);flex-wrap:wrap}
.brand{font-weight:700}.brand span{font-weight:400;color:var(--muted)}.hdr{display:flex;gap:10px;align-items:center}.hdr small{color:var(--muted)}
.shell{display:grid;grid-template-columns:200px 1fr;min-height:calc(100vh - 50px)}nav{padding:14px 10px;border-right:1px solid var(--line);display:flex;flex-direction:column;gap:2px}
nav a{padding:7px 10px;border-radius:7px;color:var(--text);text-decoration:none}nav a.on{background:var(--infobg);color:var(--info);font-weight:600}nav a:hover{background:var(--line)}
.count{background:var(--bad);color:#fff;border-radius:9px;padding:0 6px;font-size:11px;margin-left:4px}
main{padding:18px 20px 40px;max-width:1150px;min-width:0}h1{font-size:20px;margin:0 0 14px}h2{font-size:15px;margin:22px 0 8px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;margin-bottom:12px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:10px}
.tw{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:10px}table{width:100%;border-collapse:collapse;min-width:640px}
th,td{text-align:left;padding:8px 10px;border-top:1px solid var(--line);vertical-align:top}th{border-top:0;color:var(--muted);font-weight:500;font-size:12px}td small,.muted{color:var(--muted)}
a{color:var(--accent)}.badge{display:inline-block;font-size:11px;font-weight:600;border-radius:10px;padding:1px 8px;white-space:nowrap}
.badge.good{background:var(--goodbg);color:var(--good)}.badge.warn{background:var(--warnbg);color:var(--warn)}.badge.bad{background:var(--badbg);color:var(--bad)}.badge.info{background:var(--infobg);color:var(--info)}.badge.muted{background:var(--line);color:var(--muted)}
.flash{padding:10px 12px;border-radius:8px;margin-bottom:12px}.flash.good{background:var(--goodbg);color:var(--good)}.flash.bad{background:var(--badbg);color:var(--bad)}
form.inline{display:inline}button,.btn{font:inherit;border:1px solid var(--line);background:var(--card);color:var(--text);border-radius:7px;padding:6px 12px;cursor:pointer;text-decoration:none;display:inline-block}
button.primary,.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}button.danger{color:var(--bad);border-color:var(--bad)}button:hover{filter:brightness(1.05)}
.actions{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}label{display:block;font-weight:600;margin:10px 0 4px}label small{font-weight:400;color:var(--muted)}
input[type=text],input[type=number],input[type=url],textarea,select{width:100%;font:inherit;padding:8px 10px;border:1px solid var(--line);border-radius:7px;background:var(--bg);color:var(--text)}
textarea{min-height:110px}pre.mail{white-space:pre-wrap;font:13px/1.5 inherit;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px;margin:6px 0}
.kpi .v{font-size:24px;font-weight:650}.kpi .k{color:var(--muted);font-size:12px}.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center;justify-content:space-between}
details summary{cursor:pointer;color:var(--accent)}.bar{height:8px;background:var(--line);border-radius:4px;overflow:hidden;margin:4px 0}.bar span{display:block;height:100%;background:var(--accent)}
@media (max-width:760px){.shell{grid-template-columns:1fr}nav{flex-direction:row;flex-wrap:wrap;border-right:0;border-bottom:1px solid var(--line)}main{padding:14px 16px 30px}}`;

/* ------------------------------------------------------------------ pages */

function kpi(k, v, s) {
  return `<div class="card kpi"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div>${s ? `<div class="muted">${s}</div>` : ''}</div>`;
}

function postButton(action, fields, label, cls, confirmText) {
  const hidden = Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
  return `<form class="inline" method="post" action="/webhook/app-action"${confirmText ? ` onsubmit="return confirm('${esc(confirmText)}')"` : ''}><input type="hidden" name="action" value="${esc(action)}">${hidden}<button type="submit" class="${cls || ''}">${esc(label)}</button></form>`;
}

function campaignButtons(c, back) {
  const b = [];
  if (c.status === 'Ready') b.push(postButton('campaign_launch', { id: c.id, back }, 'Approve and launch', 'primary', 'Kampagne jetzt starten?'));
  if (c.status === 'Live') b.push(postButton('campaign_pause', { id: c.id, back }, 'Pausieren'));
  if (c.status === 'Paused') b.push(postButton('campaign_resume', { id: c.id, back }, 'Fortsetzen', 'primary'));
  if (['Live', 'Paused', 'Ready'].includes(c.status)) b.push(postButton('campaign_stop', { id: c.id, back }, 'Beenden', 'danger', 'Kampagne beenden? Es werden keine weiteren E-Mails gesendet.'));
  return b.join(' ');
}

function campaignStats(c, d) {
  const leads = (d.leads || []).filter((l) => leadCamp(l) === c.id);
  const ids = new Set(leads.map((l) => l.id));
  return {
    leads: leads.length,
    approved: leads.filter((l) => !['New', 'Enriching', 'Enriched', 'Drafting', 'Rejected', 'Needs review'].includes(l.status)).length,
    review: leads.filter((l) => l.status === 'Needs review').length,
    rejected: leads.filter((l) => l.status === 'Rejected').length,
    sent: (d.emails || []).filter((e) => ids.has(leadOf(e)) && e.status === 'Sent').length,
    replies: (d.replies || []).filter((r) => ids.has(leadOf(r))).length,
    positive: (d.replies || []).filter((r) => ids.has(leadOf(r)) && (r.category === 'Interested' || r.category === 'Question')).length,
    meetings: (d.meetings || []).filter((m) => ids.has(leadOf(m)) && m.status !== 'Cancelled').length,
  };
}

/**
 * Sending progress of a running campaign: first emails sent / due, follow-ups, and why sending paused (daily limit),
 * so a skip is never invisible (live: a lead waited unnoticed while the daily limit had stopped the campaign).
 */
function sendProgress(c, d, now, demoMode) {
  const S = dep('sending', './sending');
  const leads = (d.leads || []).filter((l) => leadCamp(l) === c.id && ['Approved', 'Contacted'].includes(l.status));
  const ids = new Set(leads.map((l) => l.id));
  const emails = (d.emails || []).filter((e) => ids.has(leadOf(e)));
  const firstSent = new Set(emails.filter((e) => Number(e.step) === 1 && e.status === 'Sent').map(leadOf));
  const withSequence = new Set(emails.map(leadOf));
  const day = (t) => new Date(new Date(t).getTime() + 3600000).toISOString().slice(0, 10); // ~Berlin day, display only
  const allCampaignEmails = (d.emails || []).filter((e) => (e.campaign_record_id || '') === c.id || ids.has(leadOf(e)));
  const sentToday = allCampaignEmails.filter((e) => e.status === 'Sent' && e.sent_at && day(e.sent_at) === day(now)).length;
  const limit = S.dailyLimit(c, new Set(allCampaignEmails.map(leadOf)).size, demoMode);
  return { firstSent: firstSent.size, firstTotal: withSequence.size, followUps: emails.filter((e) => Number(e.step) > 1 && e.status === 'Sent').length,
    sentToday, limit, limitReached: sentToday >= limit };
}

function pageOverview(o) {
  const d = o.data;
  const D = dep('dashboard', './dashboard');
  const dd = D.dashboardData({ clients: d.clients, campaigns: d.campaigns, leads: d.leads, emails: d.emails, replies: d.replies, meetings: d.meetings, now: o.now });
  const g = dd.guarantees.map((x) => `<div class="card"><b>${esc(x.name)}</b><div class="muted">Garantie diesen Monat</div>
    <div class="row"><span>Positive Antworten</span><b>${x.positive_replies} / ${x.target_positive_replies}</b></div><div class="bar"><span style="width:${Math.min(100, x.positive_pct)}%"></span></div>
    <div class="row"><span>Termine</span><b>${x.meetings} / ${x.target_meetings}</b></div><div class="bar"><span style="width:${Math.min(100, x.meetings_pct)}%"></span></div>
    <small class="${x.replyPace.state === 'good' ? '' : 'muted'}">${esc(x.replyPace.icon + ' ' + x.replyPace.label)}</small></div>`).join('');
  const todo = [];
  const pa = pendingApproval(d.replies).length;
  const ts = toSort(d.replies).length;
  if (pa) todo.push(`<li><a href="${href('replies')}">${pa} Antwort(en) zur Freigabe</a></li>`);
  if (ts) todo.push(`<li><a href="${href('replies')}">${ts} unklare Antwort(en) zu sortieren</a></li>`);
  (d.campaigns || []).filter((c) => c.status === 'Ready').forEach((c) => todo.push(`<li>Bereit zum Start: <a href="${href('campaign', { id: c.id })}">${esc(c.name)}</a>${c.launch_failures ? ' <span class="badge bad">Start blockiert</span>' : ''}</li>`));
  const ho = heldOpen(d.meetings, o.now).length;
  if (ho) todo.push(`<li><a href="${href('meetings')}">${ho} Termin(e): stattgefunden oder No-show?</a></li>`);
  const openTasks = (d.tasks || []).filter((t) => t.status !== 'Done');
  if (openTasks.length) todo.push(`<li><a href="${href('system')}">${openTasks.length} offene Aufgabe(n)</a></li>`);
  const errs = (d.logs || []).filter((l) => (l.level || 'error') === 'error' && new Date(l.created_at || 0).getTime() > new Date(o.now).getTime() - 86400000);
  if (errs.length) todo.push(`<li><a href="${href('system')}">${errs.length} Fehler in den letzten 24 h</a></li>`);
  const t = dd.totals;
  return layout(o, 'Übersicht', `<h2>Zu erledigen</h2><div class="card">${todo.length ? '<ul>' + todo.join('') + '</ul>' : '<span class="muted">Nichts offen – alles läuft automatisch.</span>'}</div>
  <div class="actions"><a class="btn primary" href="${href('new-campaign')}">+ Neue Kampagne</a></div>
  <h2>Garantie pro Client</h2><div class="grid">${g || '<div class="card muted">Noch keine Clients.</div>'}</div>
  <h2>Kennzahlen (alle Kampagnen)</h2><div class="grid">${kpi('Positive Antworten', t.positive_replies)}${kpi('Termine', t.meetings_booked)}${kpi('Antwortquote', t.reply_rate_pct + ' %')}${kpi('E-Mails gesendet', t.emails_sent)}</div>`);
}

/** Warnings when a campaign does not fit its client (outside the service area, or the client's own industry). */
function fitWarnings(c, client) {
  return dep('campaignFit', './campaignFit').campaignFit(c, client);
}

function pageCampaigns(o) {
  const d = o.data;
  const clients = Object.fromEntries((d.clients || []).map((c) => [c.id, c]));
  const rows = (d.campaigns || []).slice().sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || ''))).map((c) => {
    const s = campaignStats(c, d);
    const warn = fitWarnings(c, clients[campClient(c)]);
    return `<tr><td><a href="${href('campaign', { id: c.id })}"><b>${esc(c.name)}</b></a>${warn.length ? ` <span class="badge bad" title="${esc(warn.join(' '))}">passt nicht zum Client</span>` : ''}<br><small>${esc((clients[campClient(c)] || {}).name || '')} · ${esc(c.industry || '')}, ${esc(c.city || '')} · ${berlin(c.created_at, false)}</small></td>
      <td>${badge(c.status)}</td><td>${s.approved}/${s.leads}</td><td>${s.sent}</td><td>${s.replies}</td><td>${s.positive}</td><td>${s.meetings}</td><td>${campaignButtons(c, 'campaigns')}</td></tr>`;
  }).join('') || '<tr><td colspan="8">Noch keine Kampagnen. <a href="' + href('new-campaign') + '">Erste Kampagne anlegen</a></td></tr>';
  return layout(o, 'Kampagnen', `<div class="actions"><a class="btn primary" href="${href('new-campaign')}">+ Neue Kampagne</a></div>
  <div class="tw"><table><tr><th>Kampagne</th><th>Status</th><th>Freigegeben/Leads</th><th>Gesendet</th><th>Antworten</th><th>Positiv</th><th>Termine</th><th>Aktionen</th></tr>${rows}</table></div>`);
}

function pageCampaign(o) {
  const d = o.data;
  const c = (d.campaigns || []).find((x) => x.id === o.params.id);
  if (!c) return layout(o, 'Kampagne nicht gefunden', `<div class="card">Diese Kampagne gibt es nicht (mehr). <a href="${href('campaigns')}">Zur Liste</a></div>`);
  const client = (d.clients || []).find((k) => k.id === campClient(c)) || {};
  const s = campaignStats(c, d);
  const leads = (d.leads || []).filter((l) => leadCamp(l) === c.id).sort((a, b) => (b.score || 0) - (a.score || 0));
  const rows = leads.map((l) => `<tr><td><a href="${href('lead', { id: l.id })}"><b>${esc(l.company_name)}</b></a><br><small>${esc(l.city || '')}</small></td>
    <td>${esc([l.contact_salutation, l.contact_name].filter(Boolean).join(' ') || '–')}<br><small>${esc(l.contact_role || '')}${l.contact_source ? ' · ' + esc(l.contact_source) : ''}</small></td>
    <td>${esc(l.email || '–')}</td><td>${l.score ?? ''}</td><td>${l.quality_score ?? ''}</td><td>${badge(l.status)}</td>
    <td><small>${esc(l.reject_reason || l.needs_review_reason || (l.trigger ? 'Anlass: ' + l.trigger : ''))}</small></td></tr>`).join('') || '<tr><td colspan="7">Noch keine Leads – die Suche läuft.</td></tr>';
  const status = `<a href="/webhook/campaign-status?id=${esc(c.id)}">Live-Status ↗</a>`;
  return layout(o, c.name, `<div class="card"><div class="row"><div>${badge(c.status)} <b>${esc(client.name || '')}</b> · Absender ${esc(client.sender_name || '–')} · ${esc(c.industry || '')} in ${esc(c.city || '')} · Zielrolle ${esc(c.target_role || '')} · Max. ${esc(c.max_leads || '')} Leads</div><div>${status}</div></div>
    ${['Live', 'Paused'].includes(c.status) ? (() => { const p = sendProgress(c, d, o.now, (o.cfg || {}).demoMode); return `<div class="flash good">Versand: Erst-E-Mails <b>${p.firstSent} von ${p.firstTotal}</b> gesendet${p.firstSent < p.firstTotal ? ' – alle Erst-E-Mails gehen vor jedem Follow-up raus' : ''} · Follow-ups gesendet: ${p.followUps} · heute ${p.sentToday} von ${p.limit}</div>${p.limitReached && c.status === 'Live' ? `<div class="flash bad">Tageslimit erreicht (${p.limit} E-Mails) – der Versand geht morgen ab 08:00 weiter.</div>` : ''}`; })() : ''}
    ${c.launch_failures ? `<div class="flash bad">Start blockiert: ${esc(c.launch_failures)}</div>` : ''}${fitWarnings(c, client).map((x) => `<div class="flash bad">Achtung: ${esc(x)}</div>`).join('')}<div class="actions">${campaignButtons(c, 'campaign')}${['Sourcing', 'Ready'].includes(c.status) && s.leads ? ' ' + postButton('campaign_rewrite', { id: c.id }, 'Alle E-Mails neu schreiben', '', 'Alle noch nicht gesendeten E-Mails dieser Kampagne verwerfen und neu schreiben lassen (z. B. nach geändertem Angebot oder Schreibhinweisen)?') : ''}</div></div>
    <div class="grid">${kpi('Leads', s.leads)}${kpi('Freigegeben', s.approved)}${kpi('Zur Prüfung', s.review)}${kpi('Aussortiert', s.rejected)}${kpi('Gesendet', s.sent)}${kpi('Positive Antworten', s.positive)}${kpi('Termine', s.meetings)}${kpi('Kosten', ((Number(c.google_api_cost_eur) || 0) + (Number(c.ai_cost_eur) || 0)).toFixed(4).replace('.', ',') + ' €')}</div>
    <h2>Leads</h2><div class="tw"><table><tr><th>Firma</th><th>Ansprechpartner</th><th>E-Mail</th><th>Score</th><th>Qualität</th><th>Status</th><th>Grund / Anlass</th></tr>${rows}</table></div>`);
}

function pageLead(o) {
  const d = o.data;
  const l = (d.leads || []).find((x) => x.id === o.params.id);
  if (!l) return layout(o, 'Lead nicht gefunden', `<div class="card">Diesen Lead gibt es nicht (mehr).</div>`);
  const c = (d.campaigns || []).find((x) => x.id === leadCamp(l)) || {};
  const emails = (d.emails || []).filter((e) => leadOf(e) === l.id).sort((a, b) => Number(a.step) - Number(b.step));
  const replies = (d.replies || []).filter((r) => leadOf(r) === l.id).sort((a, b) => String(a.received_at).localeCompare(String(b.received_at)));
  const canRewrite = ['Approved', 'Needs review', 'Enriched'].includes(l.status) && ['Sourcing', 'Ready'].includes(c.status);
  const canExclude = !['Rejected', 'Unsubscribed', 'Bounced', 'Meeting held'].includes(l.status);
  const acts = [l.status === 'Needs review' && emails.length === 4 ? postButton('lead_approve', { id: l.id }, 'Lead freigeben', 'primary', 'Die 4 E-Mails sind geprüft und dieser Lead soll mit in die Kampagne?') : '',
    canRewrite ? postButton('lead_rewrite', { id: l.id }, 'E-Mails neu schreiben', '', 'Die 4 E-Mails dieses Leads verwerfen und von der KI neu schreiben lassen?') : '',
    canExclude ? postButton('lead_exclude', { id: l.id }, 'Lead ausschließen', 'danger', 'Diesen Lead ausschließen? Er erhält keine weiteren E-Mails.') : ''].join(' ');
  const info = [['Kampagne', `<a href="${href('campaign', { id: c.id })}">${esc(c.name || '')}</a>`], ['Status', badge(l.status)], ['Ansprechpartner', esc([l.contact_salutation, l.contact_name].filter(Boolean).join(' ') + (l.contact_role ? ' (' + l.contact_role + ')' : ''))],
    ['Quelle Kontakt', esc(l.contact_source || '')], ['E-Mail', esc(l.email || '–')], ['Website', l.website ? `<a href="${esc(l.website)}">${esc(l.website)}</a>` : ''],
    ['Telefon', esc(l.phone || '')], ['Adresse', esc(l.address || '')], ['Score', esc(l.score ?? '')], ['E-Mail-Qualität', esc(l.quality_score ?? '')], ['Anlass', esc(l.trigger || '–')],
    ['Firmenbeschreibung', esc(l.company_summary || '')], ['Grund', esc(l.reject_reason || l.needs_review_reason || '')]]
    .filter(([, v]) => v).map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('');
  const VE = dep('validateEmails', './validateEmails');
  const editable = (e) => e.status !== 'Sent' && !['Completed'].includes(c.status) && !['Rejected', 'Unsubscribed', 'Bounced'].includes(l.status);
  const mails = emails.map((e) => {
    const head = `<div class="row"><b>E-Mail ${esc(e.step)}: ${esc(e.subject_sent || e.subject)}</b><span>${badge(e.status)}${e.edited_by ? ' <small class="muted">bearbeitet</small>' : ''}</span></div>${e.subject_b ? `<small class="muted">A/B-Betreff: ${esc(e.subject_b)}</small>` : ''}`;
    if (!editable(e)) return `<div class="card">${head}<pre class="mail">${esc(e.body)}</pre>${e.sent_at ? `<small class="muted">gesendet ${berlin(e.sent_at)}</small>` : ''}</div>`;
    return `<div class="card">${head}<form method="post" action="/webhook/app-action"><input type="hidden" name="action" value="email_save"><input type="hidden" name="id" value="${esc(e.id)}">
      <label>Betreff${Number(e.step) === 1 ? ' <small>höchstens 5 Wörter</small>' : ' <small>im Thread als "Re: …" gesendet</small>'}</label><input type="text" name="subject" value="${esc(e.subject)}" required>
      <label>Nachricht <small>ohne Anrede und Signatur – beides wird automatisch ergänzt; ${Number(e.step) === 1 ? 'unter 90 Wörter' : 'höchstens 50 Wörter'}, Sie-Form, am Ende eine Frage</small></label>
      <textarea name="text" required>${esc(VE.messageText(e.body))}</textarea><div class="actions"><button type="submit">Speichern</button></div></form>
      <details><summary>So sieht die E-Mail aus</summary><pre class="mail">${esc(e.body)}</pre></details></div>`;
  }).join('') || '<div class="card muted">Noch keine E-Mails.</div>';
  const reps = replies.map((r) => `<div class="card"><div class="row"><b>${esc(r.category || '')}</b><small class="muted">${berlin(r.received_at)}</small></div><pre class="mail">${esc(r.body)}</pre>${r.suggested_reply ? `<details><summary>Antwort-Entwurf</summary><pre class="mail">${esc(r.suggested_reply)}</pre></details>` : ''}</div>`).join('');
  const reviewNote = l.status === 'Needs review' ? `<div class="flash bad">Zurückgehalten: ${esc(l.needs_review_reason || '')}. Sie können die E-Mails unten bearbeiten und den Lead dann freigeben – oder neu schreiben lassen.</div>` : '';
  return layout(o, l.company_name, `${reviewNote}<div class="actions">${acts}</div><div class="tw"><table>${info}</table></div>
    ${l.meeting_brief ? `<h2>Meeting-Briefing</h2><pre class="mail">${esc(l.meeting_brief)}</pre>` : ''}<h2>E-Mails</h2>${mails}${reps ? '<h2>Antworten</h2>' + reps : ''}`);
}

function pageReplies(o) {
  const d = o.data;
  const leads = Object.fromEntries((d.leads || []).map((l) => [l.id, l]));
  const pa = pendingApproval(d.replies).map((r) => {
    const l = leads[leadOf(r)] || {};
    return `<div class="card"><div class="row"><div><b>${esc(l.company_name || r.from_email)}</b> · ${badge(r.category)} <small class="muted">Sicherheit ${esc(r.ai_confidence ?? '')} · ${berlin(r.received_at)}</small></div><a href="${href('lead', { id: l.id })}">Lead ansehen</a></div>
      <pre class="mail">${esc(r.body)}</pre><form method="post" action="/webhook/app-action"><input type="hidden" name="action" value="reply_approve"><input type="hidden" name="id" value="${esc(r.id)}">
      <label>Antwort (anpassen möglich)</label><textarea name="text">${esc(r.suggested_reply)}</textarea><div class="actions"><button class="primary" type="submit">Freigeben und senden</button></form>
      ${postButton('reply_reject', { id: r.id }, 'Verwerfen', 'danger')}</div></div>`;
  }).join('') || '<div class="card muted">Keine Antworten warten auf Freigabe.</div>';
  const cats = [['Interested', 'Interessiert'], ['Later', 'Später'], ['Not interested', 'Kein Interesse'], ['Unsubscribe', 'Abmelden']];
  const ts = toSort(d.replies).map((r) => {
    const l = leads[leadOf(r)] || {};
    return `<div class="card"><div class="row"><b>${esc(l.company_name || r.from_email)}</b><small class="muted">${berlin(r.received_at)}</small></div><pre class="mail">${esc(r.body)}</pre>
      <div class="actions">${cats.map(([k, v]) => postButton('reply_sort', { id: r.id, category: k }, v, k === 'Interested' ? 'primary' : '')).join(' ')}</div></div>`;
  }).join('') || '<div class="card muted">Nichts zu sortieren.</div>';
  const recent = (d.replies || []).slice().sort((a, b) => String(b.received_at).localeCompare(String(a.received_at))).slice(0, 25).map((r) => {
    const l = leads[leadOf(r)] || {};
    return `<tr><td>${berlin(r.received_at)}</td><td>${l.id ? `<a href="${href('lead', { id: l.id })}">${esc(l.company_name)}</a>` : esc(r.from_email)}</td><td>${badge(r.category)}</td><td><small>${esc(r.summary || '')}</small></td><td><small>${esc(r.handled_by || (r.reply_approved ? 'beantwortet' : ''))}</small></td></tr>`;
  }).join('') || '<tr><td colspan="5">Noch keine Antworten.</td></tr>';
  return layout(o, 'Antworten', `<h2>Zur Freigabe</h2>${pa}<h2>Unklare Antworten sortieren</h2>${ts}
    <h2>Alle Antworten</h2><div class="tw"><table><tr><th>Eingang</th><th>Firma</th><th>Kategorie</th><th>Zusammenfassung</th><th>Bearbeitet</th></tr>${recent}</table></div>`);
}

function pageMeetings(o) {
  const d = o.data;
  const leads = Object.fromEntries((d.leads || []).map((l) => [l.id, l]));
  const t = new Date(o.now).getTime();
  const sorted = (d.meetings || []).slice().sort((a, b) => String(a.start_time).localeCompare(String(b.start_time)));
  const open = new Set(heldOpen(d.meetings, o.now).map((m) => m.id));
  const card = (m) => {
    const l = leads[leadOf(m)] || {};
    return `<div class="card"><div class="row"><div><b>${berlin(m.start_time)}</b> · <a href="${href('lead', { id: l.id })}">${esc(l.company_name || '')}</a> ${esc(l.contact_name ? '(' + l.contact_name + ')' : '')}</div>${badge(m.status)}</div>
      ${open.has(m.id) ? `<div class="actions">${postButton('meeting_held', { id: m.id }, 'Hat stattgefunden', 'primary')} ${postButton('meeting_noshow', { id: m.id }, 'No-show')}</div>`
    : cancellable(m, o.now) ? `<div class="actions">${postButton('meeting_cancel', { id: m.id }, 'Termin absagen', '', 'Termin wirklich absagen? Calendly informiert den Interessenten per E-Mail.')}</div>` : ''}
      ${l.meeting_brief ? `<details><summary>Meeting-Briefing</summary><pre class="mail">${esc(l.meeting_brief)}</pre></details>` : ''}</div>`;
  };
  const upcoming = sorted.filter((m) => m.status !== 'Cancelled' && new Date(m.start_time).getTime() > t - 15 * 60000).map(card).join('') || '<div class="card muted">Keine anstehenden Termine.</div>';
  const past = sorted.filter((m) => !(m.status !== 'Cancelled' && new Date(m.start_time).getTime() > t - 15 * 60000)).reverse().slice(0, 20).map(card).join('') || '<div class="card muted">Noch keine vergangenen Termine.</div>';
  return layout(o, 'Termine', `<h2>Anstehend</h2>${upcoming}<h2>Vergangen</h2>${past}`);
}

const CLIENT_FIELDS = [
  ['name', 'Name', 'genau so im Kampagnen-Formular wählbar', 'text', true],
  ['sender_name', 'Absender (Name)', 'unterschreibt die E-Mails', 'text', true],
  ['sender_title', 'Absender (Rolle)', 'z. B. Geschäftsführer', 'text'],
  ['sender_company', 'Absender (Firma)', 'in der Signatur', 'text'],
  ['sender_phone', 'Telefon', 'optional, in der Signatur', 'text'],
  ['sender_website', 'Website', 'optional, in der Signatur', 'url'],
  ['sender_company_footer', 'Impressum-Zeile (Footer)', 'Firma · Adresse · Geschäftsführer · Register', 'textarea', true],
  ['offer', 'Angebot', 'was dieser Client verkauft – die KI verspricht nur, was hier steht', 'textarea', true],
  ['writing_notes', 'Schreibhinweise', 'gelten für alle E-Mails dieses Clients, z. B. "immer das Reinigungsprotokoll erwähnen, nie günstig schreiben, kurz halten"', 'textarea'],
  ['qualifying_questions', 'Qualifizierungsfragen', 'werden Interessenten in der Antwort gestellt', 'textarea'],
  ['calendly_link', 'Buchungslink (Calendly)', 'leer = Link aus .env', 'url'],
  ['target_segments', 'Zielgruppen (Notiz)', 'z. B. Hausverwaltungen, Hotels', 'text'],
  ['industry', 'Eigene Branche', 'damit keine Wettbewerber angeschrieben werden, z. B. Gebäudereinigung', 'text'],
  ['service_area', 'Einsatzgebiet', 'Städte oder Regionen mit Komma, z. B. Berlin, Potsdam; leer oder "bundesweit" = überall', 'text'],
  ['target_positive_replies', 'Garantie: positive Antworten / Monat', '', 'number'],
  ['target_meetings', 'Garantie: Termine / Monat', '', 'number'],
];

function pageClients(o) {
  const d = o.data;
  const rows = (d.clients || []).map((k) => {
    const n = (d.campaigns || []).filter((c) => campClient(c) === k.id).length;
    return `<tr><td><a href="${href('client', { id: k.id })}"><b>${esc(k.name)}</b></a>${k.is_default ? ' <span class="badge info">Standard</span>' : ''}</td><td>${esc(k.sender_name || '')}<br><small>${esc(k.sender_title || '')}</small></td><td><small>${esc(String(k.offer || '').slice(0, 120))}</small></td><td>${n}</td></tr>`;
  }).join('') || '<tr><td colspan="4">Noch keine Clients.</td></tr>';
  return layout(o, 'Clients', `<div class="actions"><a class="btn primary" href="${href('client', { id: 'new' })}">+ Neuer Client</a></div>
    <div class="tw"><table><tr><th>Client</th><th>Absender</th><th>Angebot</th><th>Kampagnen</th></tr>${rows}</table></div>
    <p class="muted">Der Standard-Client wird verwendet, wenn eine Kampagne ohne Client angelegt wird (Nexsales eigene Akquise).</p>`);
}

function pageClient(o) {
  const d = o.data;
  const isNew = o.params.id === 'new';
  const k = isNew ? { target_positive_replies: 20, target_meetings: 4 } : (d.clients || []).find((x) => x.id === o.params.id);
  if (!k) return layout(o, 'Client nicht gefunden', '<div class="card">Diesen Client gibt es nicht.</div>');
  const fields = CLIENT_FIELDS.map(([f, l, hint, type, req]) => `<label>${esc(l)}${req ? ' *' : ''} ${hint ? `<small>${esc(hint)}</small>` : ''}</label>` +
    (type === 'textarea' ? `<textarea name="${f}"${req ? ' required' : ''}>${esc(k[f] || '')}</textarea>`
      : `<input type="${type}" name="${f}" value="${esc(k[f] ?? '')}"${req ? ' required' : ''}${type === 'number' ? ' min="0" step="1"' : ''}>`)).join('');
  return layout(o, isNew ? 'Neuer Client' : k.name, `<form method="post" action="/webhook/app-action" class="card"><input type="hidden" name="action" value="client_save"><input type="hidden" name="id" value="${isNew ? '' : esc(k.id)}">
    ${fields}<label><input type="checkbox" name="is_default" value="1"${k.is_default ? ' checked' : ''}> Standard-Client (für Kampagnen ohne Client)</label>
    <div class="actions"><button class="primary" type="submit">Speichern</button> <a class="btn" href="${href('clients')}">Abbrechen</a></div></form>`);
}

function pageNewCampaign(o) {
  const d = o.data;
  const opts = (d.clients || []).map((k) => `<option value="${esc(k.name)}"${k.is_default ? ' selected' : ''}>${esc(k.name)}${k.is_default ? ' (Standard)' : ''}</option>`).join('');
  return layout(o, 'Neue Kampagne', `<form method="post" action="/webhook/app-action" class="card"><input type="hidden" name="action" value="campaign_create">
    <label>Kampagnenname *</label><input type="text" name="name" required placeholder="Hausverwaltungen Berlin – Real Service">
    <label>Client * <small>in wessen Namen geschrieben wird</small></label><select name="client">${opts}</select>
    <p class="muted">${(d.clients || []).map((k) => `<b>${esc(k.name)}</b>: ${esc(k.service_area || 'bundesweit')}${k.industry ? ' · eigene Branche ' + esc(k.industry) : ''}`).join(' &nbsp;·&nbsp; ')}</p>
    <label>Branche (Suchbegriff) * <small>wie bei Google Maps, z. B. Hausverwaltung, Steuerberater</small></label><input type="text" name="industry" required>
    <label>Stadt *</label><input type="text" name="city" required>
    <label>Unternehmensgröße</label><select name="company_size"><option>1-9</option><option selected>10-49</option><option>50-249</option><option>250+</option></select>
    <label>Zielrolle * <small>gewünschte Ansprechpartner, wichtigste zuerst, mit Komma</small></label><input type="text" name="target_role" required value="Geschäftsführer, Inhaber">
    <label>Max. Leads <small>1–500; für einen Start im Testmodus mindestens ca. 12</small></label><input type="number" name="max_leads" min="1" max="500" value="15">
    <div class="actions"><button class="primary" type="submit">Kampagne starten (Klick 1)</button></div>
    <p class="muted">Danach laufen Suche, Anreicherung und KI-E-Mails automatisch. Den Fortschritt sehen Sie auf der Kampagnenseite.</p></form>`);
}

function pageSystem(o) {
  const d = o.data;
  const c = o.cfg || {};
  const flags = [['Testmodus (DEMO_MODE)', c.demoMode ? '<span class="badge good">an</span>' : '<span class="badge bad">aus – Echtversand möglich</span>'],
    ['Echtversand erlaubt (ALLOW_REAL_SENDING)', c.allowRealSending ? '<span class="badge bad">ja</span>' : '<span class="badge good">nein</span>'],
    ['Test-Empfänger (Allowlist)', esc((c.allowlistCount || 0) + ' Adresse(n)')], ['Externe Dienste', c.mock ? '<span class="badge warn">Mock (Test)</span>' : '<span class="badge good">echt</span>'],
    ['KI-Modell', esc(c.aiModel || '')], ['Absender-Postfach', esc(c.senderMasked || '')]]
    .map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('');
  const counts = ['clients', 'campaigns', 'leads', 'emails', 'replies', 'meetings', 'tasks'].map((t) => `${t}: <b>${(d[t] || []).length}</b>`).join(' · ');
  const tasks = (d.tasks || []).filter((t) => t.status !== 'Done').sort((a, b) => String(a.due_at).localeCompare(String(b.due_at))).map((t) => `<tr><td>${berlin(t.due_at)}</td><td>${esc(t.type || '')}</td><td>${esc(t.key || '')}<br><small>${esc(t.summary || '')}</small></td><td>${postButton('task_done', { id: t.id }, 'Erledigt')}</td></tr>`).join('') || '<tr><td colspan="4">Keine offenen Aufgaben.</td></tr>';
  const logs = (d.logs || []).slice().sort((a, b) => String(b.created_at || b.time || '').localeCompare(String(a.created_at || a.time || ''))).slice(0, 15)
    .map((l) => `<tr><td>${berlin(l.created_at || l.time)}</td><td>${esc(l.workflow || '')}</td><td><small>${esc(l.message || l.error || l.key || '')}</small></td></tr>`).join('') || '<tr><td colspan="3">Keine Fehler.</td></tr>';
  return layout(o, 'System', `<h2>Sicherheit</h2><div class="tw"><table>${flags}</table></div>
    <h2>Offene Aufgaben</h2><div class="tw"><table><tr><th>Fällig</th><th>Typ</th><th>Aufgabe</th><th></th></tr>${tasks}</table></div>
    <h2>Letzte Fehler</h2><div class="tw"><table><tr><th>Zeit</th><th>Workflow</th><th>Meldung</th></tr>${logs}</table></div>
    <h2>Daten</h2><div class="card">${counts}</div>
    <h2>Links</h2><div class="card"><a href="/">n8n (Workflows, Ausführungen)</a> · <a href="/webhook/dashboard">Dashboard</a>${c.airtableBaseId ? ` · <a href="https://airtable.com/${esc(c.airtableBaseId)}">Airtable</a>` : ''}</div>`);
}

const PAGES = { overview: pageOverview, campaigns: pageCampaigns, campaign: pageCampaign, lead: pageLead, replies: pageReplies, meetings: pageMeetings,
  clients: pageClients, client: pageClient, 'new-campaign': pageNewCampaign, system: pageSystem };

/** o: { page, params, data:{clients,campaigns,leads,emails,replies,meetings,tasks,logs}, cfg, now, user } */
function renderPage(o) {
  const opt = Object.assign({ params: {}, data: {}, now: new Date().toISOString() }, o || {});
  const fn = PAGES[opt.page] || pageOverview;
  return fn(Object.assign(opt, { page: PAGES[opt.page] ? opt.page : 'overview' }));
}

/* ------------------------------------------------------------------ actions */

const CONTROL = (action, recordId, user) => ({ kind: 'kick', path: 'control-action', body: { action, recordId, user } });
const at = (method, table, body, query) => ({ kind: 'airtable', method, table, body: body || null, query: query || '' });
const back = (page, params, msg, err) => href(page, Object.assign({}, params || {}, { msg, err: err ? '1' : '' }));

/**
 * form: the posted fields; d: current data; ctx: { user, defaultMax }
 * returns { ops: [...], redirect, after?: 'campaign_created' } or { error, redirect }
 */
function planAction(form, d, ctx) {
  const f = form || {};
  const data = d || {};
  const user = 'Control Center (' + ((ctx && ctx.user) || 'admin') + ')';
  const a = String(f.action || '');
  const fail = (msg, page, params) => ({ ops: [], error: msg, redirect: back(page || 'overview', params, msg, true) });
  const campaign = (id) => (data.campaigns || []).find((c) => c.id === id);
  const lead = (id) => (data.leads || []).find((l) => l.id === id);

  if (a === 'client_save') {
    const id = String(f.id || '');
    const fields = {};
    CLIENT_FIELDS.forEach(([k, , , type]) => {
      const v = String(f[k] === undefined ? '' : f[k]).trim();
      if (type === 'number') fields[k] = v === '' ? null : Number(v);
      else fields[k] = v || null;
    });
    fields.is_default = !!f.is_default;
    const missing = CLIENT_FIELDS.filter(([k, , , , req]) => req && !fields[k]).map(([, l]) => l);
    if (missing.length) return fail('Bitte ausfüllen: ' + missing.join(', '), 'client', { id: id || 'new' });
    if (['target_positive_replies', 'target_meetings'].some((k) => fields[k] !== null && !(Number.isInteger(fields[k]) && fields[k] >= 0))) return fail('Garantie-Werte müssen ganze Zahlen ≥ 0 sein', 'client', { id: id || 'new' });
    if ((data.clients || []).some((k) => k.id !== id && String(k.name).toLowerCase() === fields.name.toLowerCase())) return fail('Es gibt schon einen Client mit diesem Namen', 'client', { id: id || 'new' });
    if (fields.calendly_link && !/^https:\/\/\S+$/.test(fields.calendly_link)) return fail('Der Buchungslink muss mit https:// beginnen', 'client', { id: id || 'new' });
    const ops = [];
    if (fields.is_default) {
      const others = (data.clients || []).filter((k) => k.id !== id && k.is_default).map((k) => ({ id: k.id, fields: { is_default: false } }));
      if (others.length) ops.push(at('PATCH', 'Clients', { records: others, typecast: true }));
    }
    ops.push(id ? at('PATCH', 'Clients', { records: [{ id, fields }], typecast: true }) : at('POST', 'Clients', { records: [{ fields }], typecast: true }));
    return { ops, redirect: back('clients', {}, 'Client "' + fields.name + '" gespeichert.') };
  }

  if (a === 'campaign_create') {
    const C = dep('campaign', './campaign');
    const v = C.validateCampaignForm({ name: f.name, client: f.client, industry: f.industry, city: f.city, company_size: f.company_size, target_role: f.target_role, max_leads: f.max_leads },
      { defaultMax: (ctx && ctx.defaultMax) || 100 });
    if (!v.ok) return fail(v.errors.join(' · '), 'new-campaign');
    const c = v.campaign;
    const clients = data.clients || [];
    const client = clients.find((k) => c.client && String(k.name).toLowerCase() === c.client.toLowerCase()) || (c.client ? null : clients.find((k) => k.is_default) || clients[0]);
    if (!client) return fail('Unbekannter Client "' + (c.client || '') + '"', 'new-campaign');
    const fields = { name: c.name, client: [client.id], client_record_id: client.id, industry: c.industry, city: c.city, company_size: c.company_size, target_role: c.target_role,
      max_leads: c.max_leads, status: 'Sourcing', daily_limit: 40, created_at: (ctx && ctx.now) || new Date().toISOString(), google_api_requests: 0, google_api_cost_eur: 0, ai_cost_eur: 0 };
    const warn = fitWarnings(c, client);
    return { ops: [at('POST', 'Campaigns', { records: [{ fields }], typecast: true })], after: 'campaign_created', warnings: warn,
      redirect: warn.length ? back('campaigns', {}, 'Kampagne angelegt. Achtung: ' + warn.join(' '), true) : back('campaigns', {}, 'Kampagne angelegt.') };
  }

  if (/^campaign_(launch|pause|resume|stop)$/.test(a)) {
    const c = campaign(String(f.id || ''));
    const to = f.back === 'campaigns' ? ['campaigns', {}] : ['campaign', { id: f.id }];
    if (!c) return fail('Kampagne nicht gefunden', 'campaigns');
    const rule = { campaign_launch: [['Ready'], null, 'Start angestoßen: die 5 Prüfungen laufen, danach geht die Kampagne live.'],
      campaign_pause: [['Live'], 'Paused', 'Kampagne pausiert – es werden keine E-Mails gesendet.'],
      campaign_resume: [['Paused'], 'Live', 'Kampagne fortgesetzt.'],
      campaign_stop: [['Live', 'Paused', 'Ready'], 'Completed', 'Kampagne beendet.'] }[a];
    if (!rule[0].includes(c.status)) return fail('Nicht möglich bei Status "' + c.status + '"', to[0], to[1]);
    const ops = a === 'campaign_launch' ? [CONTROL('approve_launch', c.id, user)] : [at('PATCH', 'Campaigns', { records: [{ id: c.id, fields: { status: rule[1] } }], typecast: true })];
    return { ops, redirect: back(to[0], to[1], rule[2]) };
  }

  if (a === 'lead_exclude' || a === 'lead_rewrite') {
    const l = lead(String(f.id || ''));
    if (!l) return fail('Lead nicht gefunden', 'campaigns');
    if (a === 'lead_exclude') {
      return { ops: [at('PATCH', 'Leads', { records: [{ id: l.id, fields: { status: 'Rejected', reject_reason: 'Manuell ausgeschlossen (' + user + ')', next_send_at: null } }], typecast: true })],
        redirect: back('lead', { id: l.id }, 'Lead ausgeschlossen – er erhält keine weiteren E-Mails.') };
    }
    const c = campaign(leadCamp(l)) || {};
    if (!['Approved', 'Needs review', 'Enriched'].includes(l.status) || !['Sourcing', 'Ready'].includes(c.status)) return fail('Neu schreiben geht nur vor dem Start der Kampagne', 'lead', { id: l.id });
    const old = (data.emails || []).filter((e) => leadOf(e) === l.id && e.status !== 'Sent').map((e) => e.id);
    const ops = [];
    for (let i = 0; i < old.length; i += 10) ops.push(at('DELETE', 'Emails', null, old.slice(i, i + 10).map((x) => 'records[]=' + encodeURIComponent(x)).join('&')));
    ops.push(at('PATCH', 'Leads', { records: [{ id: l.id, fields: { status: 'Enriched', quality_score: null, needs_review_reason: null, claimed_at: null } }], typecast: true }));
    ops.push({ kind: 'kick', path: 'ai-emails-run', body: {} });
    return { ops, redirect: back('lead', { id: l.id }, 'Die KI schreibt die E-Mails neu – in etwa einer Minute hier sichtbar.') };
  }

  if (a === 'email_save' || a === 'lead_approve') {
    const VE = dep('validateEmails', './validateEmails');
    const e0 = a === 'email_save' ? (data.emails || []).find((e) => e.id === String(f.id || '')) : null;
    const l = a === 'email_save' ? (e0 && lead(leadOf(e0))) : lead(String(f.id || ''));
    if (!l || (a === 'email_save' && !e0)) return fail('E-Mail oder Lead nicht gefunden', 'campaigns');
    const c = campaign(leadCamp(l)) || {};
    const client = (data.clients || []).find((k) => k.id === campClient(c)) || (data.clients || []).find((k) => k.is_default) || {};
    const footer = VE.buildFooter(client);
    const opts = { senderName: client.sender_name || '', requireFooter: true, footer };
    if (a === 'email_save') {
      if (e0.status === 'Sent') return fail('Diese E-Mail ist schon gesendet', 'lead', { id: l.id });
      const text = String(f.text || '').replace(/\r\n/g, '\n').trim();
      const subject = String(f.subject || '').trim();
      if (!text || !subject) return fail('Betreff und Nachricht dürfen nicht leer sein', 'lead', { id: l.id });
      const body = VE.appendFooter(VE.ensureFrame(text, { contactName: l.contact_name || '', contactSalutation: l.contact_salutation || '', signature: VE.buildSignature(client), paragraphs: true }), footer);
      const errors = VE.validateEmail({ step: Number(e0.step), subject, body }, opts);
      if (errors.length) return fail('Nicht gespeichert – bitte anpassen: ' + errors.join('; '), 'lead', { id: l.id });
      return { ops: [at('PATCH', 'Emails', { records: [{ id: e0.id, fields: { subject, body, edited_by: user, edited_at: (ctx && ctx.now) || new Date().toISOString() } }], typecast: true })],
        redirect: back('lead', { id: l.id }, 'E-Mail ' + e0.step + ' gespeichert (Regeln geprüft).') };
    }
    if (l.status !== 'Needs review') return fail('Nur zurückgehaltene Leads können freigegeben werden', 'lead', { id: l.id });
    const running = ['Live', 'Paused'].includes(c.status);
    const es = (data.emails || []).filter((e) => leadOf(e) === l.id && e.status !== 'Sent').sort((x, y) => Number(x.step) - Number(y.step));
    if (es.length !== 4) return fail('Für die Freigabe braucht der Lead 4 E-Mails', 'lead', { id: l.id });
    const v = VE.validateSequence(es.map((e) => ({ step: Number(e.step), subject: e.subject, body: e.body })), opts);
    if (!v.ok) return fail('Noch nicht freigegeben – bitte zuerst anpassen: ' + v.errors.join('; '), 'lead', { id: l.id });
    return { ops: [at('PATCH', 'Emails', { records: es.map((e) => ({ id: e.id, fields: { status: 'Approved', approved: true, approved_by: user } })), typecast: true }),
      at('PATCH', 'Leads', { records: [{ id: l.id, fields: Object.assign({ status: 'Approved', needs_review_reason: null },
        // the campaign already runs: schedule email 1 now (sending keeps business hours and pace), otherwise it would never go out
        running ? { sequence_step: 1, next_send_at: (ctx && ctx.now) || new Date().toISOString(), subject_variant: 'A' } : {}) }], typecast: true })],
    redirect: back('lead', { id: l.id }, running ? 'Lead freigegeben – E-Mail 1 geht mit dem nächsten Versand raus.' : 'Lead freigegeben – er ist beim Start der Kampagne dabei.') };
  }

  if (a === 'campaign_rewrite') {
    const c = campaign(String(f.id || ''));
    if (!c) return fail('Kampagne nicht gefunden', 'campaigns');
    if (!['Sourcing', 'Ready'].includes(c.status)) return fail('Neu schreiben geht nur vor dem Start der Kampagne', 'campaign', { id: c.id });
    const ls = (data.leads || []).filter((l) => leadCamp(l) === c.id && ['Approved', 'Needs review', 'Enriched'].includes(l.status));
    if (!ls.length) return fail('Keine Leads zum Neuschreiben', 'campaign', { id: c.id });
    const ids = new Set(ls.map((l) => l.id));
    const old = (data.emails || []).filter((e) => ids.has(leadOf(e)) && e.status !== 'Sent').map((e) => e.id);
    const ops = [];
    for (let i = 0; i < old.length; i += 10) ops.push(at('DELETE', 'Emails', null, old.slice(i, i + 10).map((x) => 'records[]=' + encodeURIComponent(x)).join('&')));
    for (let i = 0; i < ls.length; i += 10) {
      ops.push(at('PATCH', 'Leads', { records: ls.slice(i, i + 10).map((l) => ({ id: l.id, fields: { status: 'Enriched', quality_score: null, needs_review_reason: null, claimed_at: null } })), typecast: true }));
    }
    ops.push({ kind: 'kick', path: 'ai-emails-run', body: {} });
    return { ops, redirect: back('campaign', { id: c.id }, ls.length + ' Lead(s) werden neu geschrieben – bis zu 20 sofort, weitere in den nächsten Minuten.') };
  }

  if (a === 'reply_approve' || a === 'reply_reject' || a === 'reply_sort') {
    const r = (data.replies || []).find((x) => x.id === String(f.id || ''));
    if (!r) return fail('Antwort nicht gefunden', 'replies');
    if (r.handled_at || r.reply_approved === true) return fail('Diese Antwort wurde bereits bearbeitet', 'replies');
    if (a === 'reply_reject') return { ops: [CONTROL('reply_reject', r.id, user)], redirect: back('replies', {}, 'Antwort-Entwurf verworfen.') };
    if (a === 'reply_sort') {
      const map = { Interested: 'sort_interested', Later: 'sort_later', 'Not interested': 'sort_not_interested', Unsubscribe: 'sort_unsubscribe' };
      if (!map[f.category]) return fail('Unbekannte Kategorie', 'replies');
      return { ops: [CONTROL(map[f.category], r.id, user)], redirect: back('replies', {}, 'Als "' + f.category + '" sortiert – der passende Ablauf startet.') };
    }
    const text = String(f.text || '').replace(/\r\n/g, '\n').trim();
    if (!text) return fail('Die Antwort darf nicht leer sein', 'replies');
    const ops = [];
    if (text !== String(r.suggested_reply || '').trim()) ops.push(at('PATCH', 'Replies', { records: [{ id: r.id, fields: { suggested_reply: text } }], typecast: true }));
    ops.push(CONTROL('reply_approve', r.id, user));
    return { ops, redirect: back('replies', {}, 'Antwort freigegeben und gesendet.') };
  }

  if (a === 'meeting_held' || a === 'meeting_noshow') {
    const m = (data.meetings || []).find((x) => x.id === String(f.id || ''));
    if (!m) return fail('Termin nicht gefunden', 'meetings');
    return { ops: [CONTROL(a, m.id, user)], redirect: back('meetings', {}, a === 'meeting_held' ? 'Als stattgefunden markiert.' : 'Als No-show markiert – Rückruf-Aufgabe angelegt.') };
  }

  if (a === 'meeting_cancel') {
    const m = (data.meetings || []).find((x) => x.id === String(f.id || ''));
    if (!m) return fail('Termin nicht gefunden', 'meetings');
    if (!cancellable(m, (ctx && ctx.now) || new Date().toISOString())) return fail('Dieser Termin kann nicht mehr abgesagt werden (' + (m.status || '–') + ').', 'meetings');
    return { ops: [CONTROL(a, m.id, user)], redirect: back('meetings', {}, 'Termin abgesagt – auch in Calendly, Slack bestätigt es.') };
  }

  if (a === 'task_done') {
    const t = (data.tasks || []).find((x) => x.id === String(f.id || ''));
    if (!t) return fail('Aufgabe nicht gefunden', 'system');
    return { ops: [CONTROL('task_called', t.id, user)], redirect: back('system', {}, 'Aufgabe erledigt.') };
  }

  return fail('Unbekannte Aktion', 'overview');
}

/** After the operations ran: follow-up (start sourcing for a new campaign) and the final redirect. */
function afterAction(plan, results) {
  if (plan.after === 'campaign_created') {
    const created = results && results[0] && results[0].records && results[0].records[0];
    if (!created) return { ops: [], redirect: back('campaigns', {}, 'Kampagne konnte nicht angelegt werden', true) };
    return { ops: [{ kind: 'kick', path: 'lead-sourcing', body: { campaign_record_id: created.id } }], redirect: back('campaign', { id: created.id }, 'Kampagne angelegt – die Suche läuft (Klick 1 erledigt).') };
  }
  return { ops: [], redirect: plan.redirect };
}

const controlCenterApi = { checkAuth, renderPage, planAction, afterAction, pendingApproval, toSort, heldOpen, cancellable, campaignStats, sendProgress, esc, CLIENT_FIELDS, PAGES };
if (typeof module !== 'undefined' && module.exports) module.exports = controlCenterApi;
