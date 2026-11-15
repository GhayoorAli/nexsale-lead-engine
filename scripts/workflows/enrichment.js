/** Module 3 – enrichment and scoring. */
const { Workflow, CFG } = require('../n8n_builder');

const UA = 'Mozilla/5.0 (compatible; NexsaleLeadEngine/1.0; public Impressum lookup)';

function enrichment() {
  const w = new Workflow('03_enrichment', 'Nexsale 03 – Enrichment and scoring', { description: 'Every 5 minutes: up to 20 New leads → Impressum → contact, email, register → MX → score → AI summary.' });
  w.schedule('Every 5 minutes', { field: 'minutes', minutesInterval: 5 });
  w.at(0, 1);
  w.webhook('Run now', 'enrichment-run');
  w.at(1, 0);
  w.config();
  w.atList('Load New leads', 'Leads', "\"OR({status}='New',{status}='Enriching')\"", { maxRecords: 20, maxPages: 1 });
  w.code('Claim', ['airtable'], `
const now = Date.now();
const leads = M.airtable.fromItems($('Load New leads').all()).filter((l) => l.status === 'New' || (l.status === 'Enriching' && (!l.claimed_at || now - new Date(l.claimed_at).getTime() > 15 * 60000)));
return M.airtable.updateBatches(leads.map((l) => ({ id: l.id, fields: { status: 'Enriching', claimed_at: new Date().toISOString() } }))).map((b) => ({ json: b }));`,
  { notes: 'Claims the leads so a schedule tick and a kick never process the same lead twice' });
  w.atWrite('Claim leads', 'Leads', 'PATCH');
  w.atList('Load Blocklist', 'Blocklist', null);
  w.code('Leads to fetch', ['airtable', 'guard', 'config'], `
const cfg = $('Config').first().json.cfg;
const blocklist = M.airtable.fromItems($('Load Blocklist').all());
const claimed = new Set($('Claim').all().flatMap((i) => i.json.records.map((r) => r.id)));
const leads = M.airtable.fromItems($('Load New leads').all()).filter((l) => claimed.has(l.id));
return leads.filter((l) => !M.guard.isBlocked('x@' + l.domain, blocklist)).map((l) => ({ json: {
  lead: l, home_url: M.config.webUrl(cfg, l.domain, '/'), imp_url: M.config.webUrl(cfg, l.domain, '/impressum'),
} }));`);
  const fetch = (name, urlExpr) => w.http(name, {
    method: 'GET', url: `={{ ${urlExpr} }}`, headers: [['User-Agent', UA], ['Accept-Language', 'de-DE,de;q=0.9']],
    fullResponse: true, neverError: true, text: true, timeout: 10000, continueOnFail: true, batch: { size: 5, interval: 300 },
    notes: 'Public page only, never behind a login',
  });
  fetch('Homepage', "$json.home_url");
  fetch('Impressum', "$('Leads to fetch').item.json.imp_url");
  w.code('Pick Impressum page', ['parseImpressum', 'config'], `
const cfg = $('Config').first().json.cfg;
const src = $('Leads to fetch').item.json;
const home = $('Homepage').item.json;
const imp = $json;
const body = (r) => String((r && (r.body !== undefined ? r.body : r.data)) || '');
const ok = (r) => r && Number(r.statusCode) === 200 && body(r).length > 0;
const looksLikeImpressum = (t) => /impressum|imprint|handelsregister|registergericht|geschäftsführ|inhaber|vertreten durch/i.test(t);
let found = ok(imp) && looksLikeImpressum(body(imp));
const link = ok(home) ? M.parseImpressum.findImpressumLink(body(home), src.lead.domain) : null;
const second = found ? src.imp_url : M.config.webUrl(cfg, src.lead.domain, link || '/imprint');
return { json: { lead: src.lead, found_first: found, second_url: second, link } };`, { each: true });
  fetch('Impressum (link or /imprint)', '$json.second_url');
  w.code('Parse Impressum', ['parseImpressum'], `
const picks = $('Pick Impressum page').all();
const homes = $('Homepage').all();
const imps = $('Impressum').all();
const body = (r) => String((r && (r.body !== undefined ? r.body : r.data)) || '');
return $input.all().map((second, i) => {
  const p = picks[i].json;
  const lead = p.lead;
  const html = p.found_first ? body(imps[i].json) : (Number(second.json.statusCode) === 200 ? body(second.json) : '');
  const parsed = M.parseImpressum.parseImpressum(html, lead.domain, lead.company_name);
  const text = M.parseImpressum.stripHtml(html).slice(0, 4000);
  const homeText = M.parseImpressum.stripHtml(body(homes[i].json)).slice(0, 3000);
  return { json: { ref: lead.id, lead, parsed, impressum_found: !!html, impressum_text: text, homepage_text: homeText,
    needs_fallback: !!html && !parsed.contact_name && text.length > 150 } };
});`);
  // team/contact page and jobs page: the right decision-maker and a concrete trigger (public pages only)
  w.code('Extra pages', ['contacts', 'config'], `
const cfg = $('Config').first().json.cfg;
const homes = $('Homepage').all();
const body = (r) => String((r && (r.body !== undefined ? r.body : r.data)) || '');
return $('Parse Impressum').all().map((i, k) => {
  const lead = i.json.lead;
  const links = M.contacts.findPageLinks(body(homes[k] && homes[k].json), lead.domain);
  return { json: { ref: lead.id, team_url: M.config.webUrl(cfg, lead.domain, links.team), jobs_url: M.config.webUrl(cfg, lead.domain, links.jobs) } };
});`);
  fetch('Team page', '$json.team_url');
  fetch('Jobs page', "$('Extra pages').item.json.jobs_url");
  w.atList('Campaign roles', 'Campaigns', "'OR(' + Array.from(new Set($('Parse Impressum').all().map((i) => i.json.lead.campaign_record_id))).map((id) => \"RECORD_ID()='\" + id + \"'\").join(',') + ')'", { notes: 'target_role per campaign, for picking the decision-maker' });
  w.atList('Campaign clients', 'Clients', null, { notes: 'offer per client: only triggers that fit the offer are kept' });
  w.code('Fallback requests', [], `
return $('Parse Impressum').all().filter((i) => i.json.needs_fallback).map((i) => ({ json: {
  ref: i.json.ref, prompt_id: 'impressum_fallback', vars: { domain: i.json.lead.domain, impressum_text: i.json.impressum_text }, max_tokens: 300,
} }));`, { alwaysOutputData: true, notes: 'Only leads where the regex found no name go to the AI' });
  w.execWorkflow('AI: Impressum fallback', '14_ai_call');
  w.code('Combine + MX lookup', ['parseImpressum'], `
const teams = $('Team page').all();
const homes = $('Homepage').all();
const fb = {};
$('AI: Impressum fallback').all().forEach((i) => { if (i.json && i.json.ref && i.json.ok) fb[i.json.ref] = i.json; });
return $('Parse Impressum').all().map((i, k) => {
  const j = i.json;
  const p = Object.assign({}, j.parsed);
  let ai_cost = 0;
  const f = fb[j.ref];
  if (f) {
    ai_cost += f.cost_eur || 0;
    if (!p.contact_name && f.data.contact_name) { p.contact_name = f.data.contact_name; p.contact_role = f.data.contact_role || 'Geschäftsführer'; p.name_source = 'ai'; }
    if (!p.email && f.data.email && String(f.data.email).toLowerCase().endsWith('@' + j.lead.domain)) p.email = String(f.data.email).toLowerCase();
  }
  // many small firms publish their email only on the contact page or the homepage (incl. mailto: links)
  if (!p.email) {
    const html = (r) => (r && r.json && Number(r.json.statusCode) === 200 ? String(r.json.body !== undefined ? r.json.body : r.json.data || '') : '');
    for (const [src, page] of [['Kontaktseite', teams[k]], ['Startseite', homes[k]]]) {
      const h = html(page);
      if (!h) continue;
      const r = M.parseImpressum.parseImpressum(h, j.lead.domain, j.lead.company_name);
      const e = r.email || M.parseImpressum.pickEmail(r.emails, j.lead.domain, j.lead.company_name, p.contact_name);
      if (e) { p.email = e; p.emails = Array.from(new Set((p.emails || []).concat(r.emails))); p.email_source = src; break; }
    }
  }
  const mxDomain = p.email ? p.email.split('@')[1] : j.lead.domain;
  return { json: Object.assign({}, j, { parsed: p, ai_cost, mx_domain: mxDomain }) };
});`);
  w.http('MX lookup (DNS over HTTPS)', {
    method: 'GET', url: `={{ ${CFG('dnsUrl')} }}/resolve`, query: [['name', '={{ $json.mx_domain }}'], ['type', 'MX']],
    headers: [['Accept', 'application/dns-json']], neverError: true, continueOnFail: true, timeout: 8000, batch: { size: 5, interval: 200 },
  });
  w.code('Score', ['score'], `
const combined = $('Combine + MX lookup').all();
return $input.all().map((dns, i) => {
  const j = combined[i].json;
  const ans = (dns.json && dns.json.Answer) || [];
  const mx_ok = dns.json && dns.json.Status === 0 && ans.some((a) => a.type === 15);
  const lead = Object.assign({}, j.lead, j.parsed, { mx_ok, hiring_signal: !!j.lead.hiring_signal });
  const s = M.score.scoreLead(lead);
  const d = M.score.decideStatus(lead, s.score);
  return { json: Object.assign({}, j, { mx_ok, score: s.score, breakdown: s.breakdown, decision: d }) };
});`);
  w.code('Summary requests', ['parseImpressum', 'airtable', 'validateEmails'], `
const body = (r) => String((r && r.json && Number(r.json.statusCode) === 200 && (r.json.body !== undefined ? r.json.body : r.json.data)) || '');
const teams = $('Team page').all(), jobs = $('Jobs page').all();
const camps = Object.fromEntries(M.airtable.fromItems($('Campaign roles').all()).map((c) => [c.id, c]));
const clients = M.airtable.fromItems($('Campaign clients').all());
const offerOf = (camp) => { const k = clients.find((x) => x.id === (camp || {}).client_record_id) || clients.find((x) => x.is_default) || clients[0] || {}; return M.validateEmails.offerText(k, (camp || {}).industry); };
return $('Score').all().map((i, k) => ({ i, k })).filter((x) => x.i.json.decision.status === 'Enriched').map(({ i, k }) => {
  const team = M.parseImpressum.stripHtml(body(teams[k])).slice(0, 3000);
  const job = M.parseImpressum.stripHtml(body(jobs[k])).slice(0, 2000);
  const roles = (camps[i.json.lead.campaign_record_id] || {}).target_role || 'Geschäftsführer';
  return { json: {
    ref: i.json.ref, prompt_id: 'company_summary', max_tokens: 700, page_text: [i.json.homepage_text, team, job, i.json.impressum_text].join('\\n'), target_role: roles,
    vars: { company_name: i.json.lead.company_name, city: i.json.lead.city, homepage_text: i.json.homepage_text || '(keine Startseite verfügbar)',
      team_text: team || '(keine Team-/Kontaktseite gefunden)', jobs_text: job || '(keine Karriereseite gefunden)', target_roles: roles,
      offer: offerOf(camps[i.json.lead.campaign_record_id]) },
  } };
});`, { alwaysOutputData: true });
  w.execWorkflow('AI: company summary', '14_ai_call');
  w.atList('Known emails', 'Leads', "\"AND(OR({email}!='',{contact_name}!=''),{status}!='Rejected')\"", { notes: 'One person, one sequence: contacts already used by other leads' });
  w.code('Lead updates', ['airtable', 'score', 'contacts', 'parseImpressum'], `
const sums = {};
$('AI: company summary').all().forEach((i) => { if (i.json && i.json.ref) sums[i.json.ref] = i.json; });
const reqs = Object.fromEntries($('Summary requests').all().filter((i) => i.json && i.json.ref).map((i) => [i.json.ref, i.json]));
const costByCampaign = {};
const updates = $('Score').all().map((i) => {
  const j = i.json;
  const s = sums[j.ref];
  const req = reqs[j.ref];
  // the right decision-maker from the team/contact page (verified on the page), else the Impressum person
  const picked = s && s.ok && req ? M.contacts.pickContact({ contacts: s.data.contacts, targetRole: req.target_role, pageText: req.page_text,
    domain: j.lead.domain, companyName: j.lead.company_name, impressum: j.parsed, relatedDomain: M.parseImpressum.relatedDomain }) : null;
  const p = Object.assign({}, j.parsed, picked && picked.contact_name ? picked : {});
  const trigger = s && s.ok && req ? M.contacts.verifiedTrigger(s.data.trigger, req.page_text) : '';
  const cost = (j.ai_cost || 0) + ((s && s.cost_eur) || 0);
  const cid = j.lead.campaign_record_id;
  costByCampaign[cid] = (costByCampaign[cid] || 0) + cost;
  return { id: j.ref, fields: {
    contact_name: p.contact_name || null, contact_role: p.contact_role || null, contact_salutation: (p.name_source === 'ai' ? null : p.contact_salutation) || null, email: p.email || null,
    contact_source: p.contact_source || (p.contact_name ? (p.name_source === 'ai' ? 'Impressum (KI)' : 'Impressum') : null), trigger: trigger || null,
    emails_found: (p.emails || []).join(', ') || null, register_number: p.register_number || null, legal_form: p.legal_form || null,
    mx_ok: j.mx_ok, score: j.score, score_breakdown: JSON.stringify(j.breakdown),
    status: j.decision.status, reject_reason: j.decision.reason || (j.impressum_found ? null : 'no Impressum page found'),
    company_summary: s && s.ok ? s.data.summary : null,
  } };
});
// leads where no Impressum was found get a clearer reason
const batchIds = new Set(updates.map((u) => u.id));
const known = M.airtable.fromItems($('Known emails').all()).filter((l) => !batchIds.has(l.id));
const byRef = Object.fromEntries($('Score').all().map((i) => [i.json.ref, i.json.lead]));
updates.forEach((u) => { const l = byRef[u.id] || {}; u.company_name = l.company_name; u.address = l.address; u.phone = l.phone; });
const deduped = M.score.markDuplicateContacts(updates, known);
updates.splice(0, updates.length, ...deduped.map((u) => ({ id: u.id, fields: u.fields })));
updates.forEach((u) => { if (u.fields.status === 'Rejected' && u.fields.reject_reason === 'no email found in Impressum') {
  const sc = $('Score').all().find((i) => i.json.ref === u.id); if (sc && !sc.json.impressum_found) u.fields.reject_reason = 'no Impressum page found'; } });
const stats = { enriched: updates.filter((u) => u.fields.status === 'Enriched').length, rejected: updates.filter((u) => u.fields.status === 'Rejected').length,
  with_email: updates.filter((u) => u.fields.email).length, total: updates.length, costByCampaign };
return M.airtable.updateBatches(updates).map((b) => ({ json: Object.assign(b, { stats }) }));`);
  w.atWrite('Update leads', 'Leads', 'PATCH');
  w.atList('Load campaigns', 'Campaigns', "'OR(' + Object.keys($('Lead updates').first().json.stats.costByCampaign).map((id) => \"RECORD_ID()='\" + id + \"'\").join(',') + ')'");
  w.code('Campaign cost + Slack', ['airtable'], `
const stats = $('Lead updates').first().json.stats;
const camps = M.airtable.fromItems($('Load campaigns').all());
const updates = camps.map((c) => ({ id: c.id, fields: { ai_cost_eur: Math.round(((c.ai_cost_eur || 0) + (stats.costByCampaign[c.id] || 0)) * 10000) / 10000 } }));
const names = camps.map((c) => c.name).join(', ');
return M.airtable.updateBatches(updates).map((b) => ({ json: Object.assign(b, {
  slack: { ref: 'enrichment', text: ':label: Enrichment for *' + names + '*: ' + stats.enriched + ' enriched, ' + stats.rejected + ' rejected, ' + stats.with_email + '/' + stats.total + ' with email' },
}) }));`);
  w.atWrite('Update campaign cost', 'Campaigns', 'PATCH');
  w.code('Slack message', [], `return [{ json: $('Campaign cost + Slack').first().json.slack }];`);
  w.execWorkflow('Post to Slack', '15_slack_notify');
  w.kick('Start AI emails', 'ai-emails-run');
  w.connect('Every 5 minutes', 'Config');
  w.connect('Run now', 'Config');
  w.chain('Config', 'Load New leads', 'Claim', 'Claim leads', 'Load Blocklist', 'Leads to fetch', 'Homepage', 'Impressum', 'Pick Impressum page',
    'Impressum (link or /imprint)', 'Parse Impressum', 'Extra pages', 'Team page', 'Jobs page', 'Campaign roles', 'Campaign clients', 'Fallback requests', 'AI: Impressum fallback', 'Combine + MX lookup', 'MX lookup (DNS over HTTPS)',
    'Score', 'Summary requests', 'AI: company summary', 'Known emails', 'Lead updates', 'Update leads', 'Load campaigns', 'Campaign cost + Slack', 'Update campaign cost',
    'Slack message', 'Post to Slack', 'Start AI emails');
  // blocked domains are rejected on a side branch
  w.at(5, 2);
  w.code('Blocked leads', ['airtable', 'guard'], `
const blocklist = M.airtable.fromItems($('Load Blocklist').all());
const claimed = new Set($('Claim').all().flatMap((i) => i.json.records.map((r) => r.id)));
const leads = M.airtable.fromItems($('Load New leads').all()).filter((l) => claimed.has(l.id) && M.guard.isBlocked('x@' + l.domain, blocklist));
return M.airtable.updateBatches(leads.map((l) => ({ id: l.id, fields: { status: 'Rejected', reject_reason: 'domain on Blocklist' } }))).map((b) => ({ json: b }));`);
  w.atWrite('Reject blocked', 'Leads', 'PATCH');
  w.connect('Load Blocklist', 'Blocked leads');
  w.connect('Blocked leads', 'Reject blocked');
  return w;
}

module.exports = [enrichment];
