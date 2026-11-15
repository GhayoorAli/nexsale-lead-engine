/**
 * statusPage.js – the page the campaign form lands on after click 1.
 * Shows live progress (found → checked → emails written → ready) and refreshes itself until the campaign is Ready.
 * Pure function: data in, HTML out (escaped), so it is unit-tested without n8n.
 */
const IN_ENRICHMENT = ['New', 'Enriching'];
const BEFORE_EMAILS = ['New', 'Enriching', 'Enriched', 'Drafting'];
const APPROVED_OR_LATER = ['Approved', 'Contacted', 'Replied', 'Interested', 'Later', 'Meeting booked', 'Meeting held', 'No-show', 'Not interested', 'Unsubscribed', 'Bounced'];

function esc(s) {
  return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Counts and step states from the campaign and its leads. */
function progress(campaign, leads) {
  const c = campaign || {};
  const L = (leads || []).filter(Boolean);
  const count = (pred) => L.filter(pred).length;
  const found = L.length;
  const rejected = count((l) => l.status === 'Rejected');
  const enrichedDone = count((l) => !IN_ENRICHMENT.includes(l.status));
  const emailsDone = count((l) => !BEFORE_EMAILS.includes(l.status) && l.status !== 'Rejected');
  const approved = count((l) => APPROVED_OR_LATER.includes(l.status));
  const review = count((l) => l.status === 'Needs review');
  const st = c.status || 'Sourcing';
  const ready = ['Ready', 'Launch', 'Live', 'Paused', 'Completed'].includes(st);
  const live = ['Live', 'Paused', 'Completed'].includes(st);
  const sourced = found > 0 || ready || Number(c.google_api_requests) > 0;
  const enrichFinished = sourced && found > 0 && enrichedDone === found;
  const steps = [
    { key: 'created', label: 'Kampagne angelegt', detail: esc(c.name), state: 'done' },
    { key: 'sourced', label: 'Firmen bei Google gefunden', detail: sourced ? found + ' Firmen mit Website' : 'Suche läuft …', state: sourced ? 'done' : 'active' },
    { key: 'enriched', label: 'Impressum geprüft, Ansprechpartner und E-Mail gefunden', detail: sourced ? (enrichedDone + ' von ' + found + ' geprüft · ' + (found - rejected) + ' passend · ' + rejected + ' aussortiert') : '',
      state: enrichFinished || ready ? 'done' : sourced ? 'active' : 'pending' },
    { key: 'emails', label: 'Persönliche E-Mails geschrieben und geprüft', detail: enrichFinished || ready ? (approved + ' freigegeben' + (review ? ' · ' + review + ' zur Prüfung' : '')) : '',
      state: ready ? 'done' : enrichFinished ? 'active' : 'pending' },
    { key: 'ready', label: live ? 'Kampagne läuft' : 'Bereit zum Start', detail: live ? 'E-Mails werden versendet' : ready ? 'Öffnen Sie Slack #leads und klicken Sie "Approve and launch"' : '',
      state: ready ? 'done' : 'pending' },
  ];
  return { found, rejected, enrichedDone, emailsDone, approved, review, ready, live, status: st, steps };
}

const ICON = { done: '&#10003;', active: '&#8226;', pending: '' };

/**
 * opts: { campaign, leads, airtableUrl, refreshSeconds, notFound }
 */
function renderStatusPage(opts) {
  const o = opts || {};
  if (o.notFound || !o.campaign) {
    return page('Kampagne nicht gefunden', '<p class="lead">Diese Kampagne gibt es nicht (mehr). Starten Sie eine neue über das Formular.</p>', 0);
  }
  const p = progress(o.campaign, o.leads);
  const refresh = p.ready ? 0 : (o.refreshSeconds || 5);
  const steps = p.steps.map((s) => `<li class="${s.state}"><span class="dot">${ICON[s.state]}</span><div><b>${esc(s.label)}</b>${s.detail ? `<small>${s.detail}</small>` : ''}</div></li>`).join('');
  const top = (o.leads || []).filter((l) => APPROVED_OR_LATER.includes(l.status)).slice(0, 100)
    .map((l) => `<tr><td>${esc(l.company_name)}</td><td>${esc(l.contact_name || '–')}</td><td>${esc(l.quality_score || '')}</td></tr>`).join('');
  const headline = p.live ? 'Die Kampagne läuft' : p.ready ? 'Kampagne bereit: Klick 2 und 3 in Slack' : 'Ihre Kampagne wird vorbereitet';
  const sub = p.ready ? '' : '<p class="lead">Klick 1 ist erledigt. Alles Weitere läuft automatisch, diese Seite aktualisiert sich selbst (meist unter 2 Minuten).</p>';
  const next = p.ready && !p.live
    ? `<div class="next"><b>Nächster Schritt:</b> Öffnen Sie in Slack den Kanal <b>#leads</b>, prüfen Sie die Nachricht "Campaign ready" (Klick 2) und klicken Sie <b>Approve and launch</b> (Klick 3).</div>` : '';
  const table = top ? `<h2>Freigegebene Leads</h2><table><tr><th>Firma</th><th>Ansprechpartner</th><th>Qualität</th></tr>${top}</table>` : '';
  const link = (o.airtableUrl ? `<p class="links"><a href="${esc(o.airtableUrl)}" target="_blank" rel="noopener">Alle Leads und E-Mails in Airtable öffnen</a></p>` : '')
    + (o.dashboardUrl ? `<p class="links"><a href="${esc(o.dashboardUrl)}">Zum Dashboard</a></p>` : '');
  return page(headline, `${sub}<ol class="steps">${steps}</ol>${next}${table}${link}`, refresh, o.campaign.name);
}

function page(title, body, refresh, name) {
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
${refresh ? `<meta http-equiv="refresh" content="${Number(refresh)}">` : ''}<title>${esc(name ? name + ' · Status' : 'Kampagnenstatus')}</title>
<style>
:root{--bg:#f7f8fb;--card:#fff;--text:#1f2430;--muted:#667085;--line:#e4e7ec;--accent:#ff5a4e;--ok:#12805c;--okbg:#e7f6ef}
@media (prefers-color-scheme:dark){:root{--bg:#14161b;--card:#1d2027;--text:#eceef2;--muted:#9aa3b2;--line:#2c313b;--ok:#4cc38a;--okbg:#17352a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.card{max-width:560px;margin:32px auto;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:28px 24px}
@media (max-width:600px){.card{margin:16px;padding:20px 16px}}
h1{font-size:21px;margin:0 0 6px}h2{font-size:15px;margin:22px 0 8px}.lead{color:var(--muted);margin:0 0 18px}
.steps{list-style:none;padding:0;margin:0}.steps li{display:flex;gap:12px;padding:10px 0;border-top:1px solid var(--line)}.steps li:first-child{border-top:0}
.dot{flex:0 0 24px;height:24px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:13px;border:2px solid var(--line);color:var(--muted)}
.done .dot{background:var(--okbg);border-color:var(--ok);color:var(--ok)}.active .dot{border-color:var(--accent);color:var(--accent);animation:p 1.2s infinite}
.pending b{color:var(--muted);font-weight:500}small{display:block;color:var(--muted)}
@keyframes p{50%{opacity:.35}}
.next{margin-top:18px;padding:12px 14px;border-radius:8px;background:var(--okbg);border:1px solid var(--ok)}
table{width:100%;border-collapse:collapse;font-size:14px}td,th{text-align:left;padding:6px 4px;border-top:1px solid var(--line)}th{color:var(--muted);font-weight:500}
.links a{color:var(--accent)}
</style></head><body><div class="card"><h1>${esc(title)}</h1>${body}</div></body></html>`;
}

const statusPageApi = { progress, renderStatusPage, esc };
if (typeof module !== 'undefined' && module.exports) module.exports = statusPageApi;
