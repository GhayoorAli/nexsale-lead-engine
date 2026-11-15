/** Module 4 – AI email sequences, AI quality check, "Campaign ready" (click 2). */
const { Workflow } = require('../n8n_builder');

function aiEmails() {
  const w = new Workflow('04_ai_emails', 'Nexsale 04 – AI emails and Campaign ready', { description: '4-step German sequence per Enriched lead, AI quality check (80+), rewrite once, then "Campaign ready" in Slack + email.' });
  w.schedule('Every 5 minutes', { field: 'minutes', minutesInterval: 5 });
  w.at(0, 1);
  w.webhook('Run now', 'ai-emails-run');
  w.at(1, 0);
  w.config();
  w.atList('Load Enriched leads', 'Leads', "\"OR({status}='Enriched',{status}='Drafting')\"", { maxRecords: 20, maxPages: 1 });
  // Ready too: a lead whose emails are rewritten from the Control Center before launch (the ready check stays Sourcing-only)
  w.atList('Load campaigns', 'Campaigns', "\"OR({status}='Sourcing',{status}='Ready')\"");
  w.atList('Load clients', 'Clients', null);
  w.code('Claim', ['airtable'], `
const now = Date.now();
const camps = new Set(M.airtable.fromItems($('Load campaigns').all()).map((c) => c.id));
const leads = M.airtable.fromItems($('Load Enriched leads').all()).filter((l) => camps.has(l.campaign_record_id) &&
  (l.status === 'Enriched' || (l.status === 'Drafting' && (!l.claimed_at || now - new Date(l.claimed_at).getTime() > 15 * 60000))));
return M.airtable.updateBatches(leads.map((l) => ({ id: l.id, fields: { status: 'Drafting', claimed_at: new Date().toISOString() } }))).map((b) => ({ json: b }));`, { alwaysOutputData: true });
  w.ifTrue('Anything to draft?', '($json.records || []).length > 0');
  w.atWrite('Claim leads', 'Leads', 'PATCH');
  w.code('Sequence requests', ['airtable', 'validateEmails'], `
const claimed = new Set($('Claim').all().flatMap((i) => (i.json.records || []).map((r) => r.id)));
const leads = M.airtable.fromItems($('Load Enriched leads').all()).filter((l) => claimed.has(l.id));
const camps = Object.fromEntries(M.airtable.fromItems($('Load campaigns').all()).map((c) => [c.id, c]));
const clients = M.airtable.fromItems($('Load clients').all());
return leads.map((l) => {
  const c = camps[l.campaign_record_id] || {};
  const client = clients.find((k) => k.id === c.client_record_id) || clients[0] || {};
  return { json: { ref: l.id, prompt_id: 'email_sequence', max_tokens: 1600,
    validate_opts: { senderName: client.sender_name || 'Anna Berger', contactName: l.contact_name || '', contactSalutation: l.contact_salutation || '', signature: M.validateEmails.buildSignature(client) }, vars: {
    sender_name: client.sender_name || 'Anna Berger', sender_title: client.sender_title || 'Neukundengewinnung', sender_company: client.sender_company || client.name || 'Nexsale GmbH',
    offer: M.validateEmails.offerText(client, c.industry), writing_notes: String(client.writing_notes || '').trim() || '(keine)', industry: c.industry || '', target_role: c.target_role || 'Geschäftsführer',
    company_name: l.company_name, city: l.city || c.city || '', contact_name: l.contact_name || 'unbekannt', contact_role: l.contact_role || '',
    company_summary: l.company_summary || '(keine Beschreibung)', trigger: l.trigger || '(kein Anlass bekannt)', google_rating: l.google_rating || '-', review_count: l.review_count || 0,
  } } };
});`);
  w.execWorkflow('AI: write sequence', '14_ai_call');
  const qualityReq = (name, source) => w.code(name, ['validateEmails'], `
const leads = Object.fromEntries($('Sequence requests').all().map((i) => [i.json.ref, i.json.vars]));
return $('${source}').all().filter((i) => i.json && i.json.ref && i.json.ok).map((i) => {
  const seq = M.validateEmails.normaliseSequence(i.json.data);
  const v = leads[i.json.ref];
  return { json: { ref: i.json.ref, prompt_id: 'quality_check', max_tokens: 600, temperature: 0, vars: {
    company_summary: v.company_summary, contact_name: v.contact_name, offer: v.offer, industry: v.industry, city: v.city, trigger: v.trigger,
    sequence: seq.map((e) => 'E-Mail ' + e.step + '\\nBetreff: ' + e.subject + '\\n' + e.body).join('\\n\\n'),
    // exact, code-checked facts: the model must not re-count them (live test: it reported 97 words for a 46-word email)
    auto_checks: '- Wortanzahl je E-Mail (E-Mail 1 max. 89, Follow-ups max. 50): ' + seq.map((e) => 'E-Mail ' + e.step + ': ' + M.validateEmails.countWords(e.body)).join(', ') +
      '\\n- Durchgehend Sie-Form, keine Ausrufezeichen, keine Platzhalter',
  } } };
});`, { alwaysOutputData: true });
  qualityReq('Quality requests', 'AI: write sequence');
  w.execWorkflow('AI: quality check', '14_ai_call');
  w.code('Rewrite requests', [], `
const q = Object.fromEntries($('AI: quality check').all().filter((i) => i.json && i.json.ref).map((i) => [i.json.ref, i.json]));
return $('Sequence requests').all().filter((i) => {
  const s = $('AI: write sequence').all().find((x) => x.json && x.json.ref === i.json.ref);
  const qq = q[i.json.ref];
  return s && s.json.ok && qq && qq.ok && Number(qq.data.score) < 80;
}).map((i) => {
  const qq = q[i.json.ref];
  const hint = 'Die vorige Version erhielt nur ' + qq.data.score + '/100. Probleme: ' + (qq.data.issues || []).join('; ') + '. Hinweis: ' + (qq.data.rewrite_hint || '') + '. Schreibe die Sequenz neu und behebe diese Punkte.';
  return { json: Object.assign({}, i.json, { vars: Object.assign({}, i.json.vars, { retry_note: hint }) }) };
});`, { alwaysOutputData: true, notes: 'Below 80: rewritten once' });
  w.execWorkflow('AI: rewrite sequence', '14_ai_call');
  qualityReq('Quality 2 requests', 'AI: rewrite sequence');
  w.execWorkflow('AI: quality check 2', '14_ai_call');
  w.code('Finalize sequences', ['validateEmails', 'airtable'], `
const by = (node) => Object.fromEntries($(node).all().filter((i) => i.json && i.json.ref).map((i) => [i.json.ref, i.json]));
const seq1 = by('AI: write sequence'), q1 = by('AI: quality check'), seq2 = by('AI: rewrite sequence'), q2 = by('AI: quality check 2');
const camps = Object.fromEntries(M.airtable.fromItems($('Load campaigns').all()).map((c) => [c.id, c]));
const clients = M.airtable.fromItems($('Load clients').all());
const leads = Object.fromEntries(M.airtable.fromItems($('Load Enriched leads').all()).map((l) => [l.id, l]));
const emails = [];
const leadUpdates = [];
const cost = {};
$('Sequence requests').all().forEach((i) => {
  const ref = i.json.ref;
  const lead = leads[ref];
  const camp = camps[lead.campaign_record_id] || {};
  const client = clients.find((k) => k.id === camp.client_record_id) || clients[0] || {};
  const footer = M.validateEmails.buildFooter(client);
  const useRewrite = !!(seq2[ref] && seq2[ref].ok);
  const s = useRewrite ? seq2[ref] : seq1[ref];
  const q = useRewrite ? q2[ref] : q1[ref];
  cost[lead.campaign_record_id] = (cost[lead.campaign_record_id] || 0) + [seq1, q1, seq2, q2].reduce((a, m) => a + ((m[ref] && m[ref].cost_eur) || 0), 0);
  if (!s || !s.ok) {
    leadUpdates.push({ id: ref, fields: { status: 'Needs review', needs_review_reason: 'AI output invalid after one retry: ' + ((s && s.errors) || ['no output']).join('; ').slice(0, 300) } });
    return;
  }
  const quality = q && q.ok ? Number(q.data.score) : 0;
  const seq = M.validateEmails.normaliseSequence(s.data).map((e) => Object.assign({}, e, { body: M.validateEmails.appendFooter(e.body, footer) }));
  const final = M.validateEmails.validateSequence(seq, { footer, requireFooter: true });
  const pass = quality >= 80 && final.ok;
  const alt = (Array.isArray(s.data.emails) ? s.data.emails : []).find((e) => Number(e.step) === 1);
  seq.forEach((e) => emails.push({
    key: lead.company_name + ' · step ' + e.step, lead: [ref], lead_record_id: ref, campaign_record_id: lead.campaign_record_id,
    step: e.step, subject: e.subject, subject_b: e.step === 1 && alt && alt.subject_alt ? String(alt.subject_alt).trim() : null,
    body: e.body, approved: pass, quality_score: quality, status: pass ? 'Approved' : 'Draft',
  }));
  leadUpdates.push({ id: ref, fields: pass
    ? { status: 'Approved', quality_score: quality }
    : { status: 'Needs review', quality_score: quality, needs_review_reason: quality < 80 ? 'quality ' + quality + ' below 80 after one rewrite' : final.errors.join('; ').slice(0, 300) } });
});
const batches = M.airtable.createBatches(emails);
// always emit one item: the lead updates (e.g. all leads "Needs review") must reach Airtable even with 0 emails
return (batches.length ? batches : [{ records: [] }]).map((b) => ({ json: Object.assign(b, { leadUpdates, cost }) }));`);
  w.ifTrue('Any emails?', '($json.records || []).length > 0');
  w.atWrite('Create emails', 'Emails', 'POST');
  w.code('Lead updates', ['airtable'], `
const f = $('Finalize sequences').first().json;
return M.airtable.updateBatches(f.leadUpdates || []).map((b) => ({ json: b }));`);
  w.atWrite('Update leads', 'Leads', 'PATCH');
  w.code('Campaign AI cost', ['airtable'], `
const cost = $('Finalize sequences').first().json.cost || {};
const camps = M.airtable.fromItems($('Load campaigns').all()).filter((c) => cost[c.id]);
return M.airtable.updateBatches(camps.map((c) => ({ id: c.id, fields: { ai_cost_eur: Math.round(((c.ai_cost_eur || 0) + cost[c.id]) * 10000) / 10000 } }))).map((b) => ({ json: b }));`, { alwaysOutputData: true });
  w.ifTrue('Any cost?', '($json.records || []).length > 0');
  w.atWrite('Update campaign cost', 'Campaigns', 'PATCH');

  // ---- Campaign ready check (runs every time, also when no lead was drafted in this run)
  w.at(4, 3);
  w.atList('Sourcing campaigns', 'Campaigns', "\"{status}='Sourcing'\"", { notes: 'Fresh read after drafting' });
  w.atList('Their leads', 'Leads', "'OR(' + ($('Sourcing campaigns').all().flatMap((i) => (i.json.records || []).map((r) => \"{campaign_record_id}='\" + r.id + \"'\")).join(',') || \"{campaign_record_id}='__none__'\") + ')'");
  w.code('Ready campaigns', ['airtable'], `
const PENDING = ['New', 'Enriching', 'Enriched', 'Drafting', 'Drafted'];
const camps = M.airtable.fromItems($('Sourcing campaigns').all());
const leads = M.airtable.fromItems($('Their leads').all());
const ready = camps.filter((c) => c.leads_sourced !== undefined && c.leads_sourced !== null).filter((c) => {
  const ls = leads.filter((l) => l.campaign_record_id === c.id);
  return ls.length === Number(c.leads_sourced) && !ls.some((l) => PENDING.includes(l.status));
});
return ready.map((c) => ({ json: { campaign: c, leads: leads.filter((l) => l.campaign_record_id === c.id) } }));`);
  w.atList('Approved emails', 'Emails', "'OR(' + $('Ready campaigns').all().map((i) => \"{campaign_record_id}='\" + i.json.campaign.id + \"'\").join(',') + ')'");
  w.code('Campaign ready messages', ['airtable', 'slackMessages'], `
const cfg = $('Config').first().json.cfg;
const emails = M.airtable.fromItems($('Approved emails').all());
return $('Ready campaigns').all().map((i) => {
  const c = i.json.campaign;
  const approved = i.json.leads.filter((l) => l.status === 'Approved');
  const avg = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);
  const samples = approved.slice().sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 3).map((l) => {
    const e1 = emails.find((e) => e.lead_record_id === l.id && Number(e.step) === 1) || {};
    return { company: l.company_name, score: l.score, quality: l.quality_score, subject: e1.subject || '', body: String(e1.body || '').split('\\n-- ')[0] };
  });
  const client = M.airtable.fromItems($('Load clients').all()).find((k) => k.id === c.client_record_id) || {};
  const msg = M.slackMessages.campaignReady({
    name: c.name, campaignRecordId: c.id, client: client.name, sender: [client.sender_name, client.sender_company].filter(Boolean).join(', '), leadCount: approved.length, avgScore: avg(approved.map((l) => l.score || 0)),
    avgQuality: avg(approved.map((l) => l.quality_score || 0)), flagged: i.json.leads.filter((l) => l.status === 'Needs review').length,
    rejected: i.json.leads.filter((l) => l.status === 'Rejected').length, samples, listUrl: cfg.interfaceUrl || (cfg.n8nBaseUrl + '/webhook/campaign-status?id=' + c.id),
  });
  return { json: { ref: c.id, text: msg.text, blocks: msg.blocks, approvedCount: approved.length, samples, name: c.name, client: client.name || '',
    sender: [client.sender_name, client.sender_company].filter(Boolean).join(', '), avgScore: avg(approved.map((l) => l.score || 0)),
    avgQuality: avg(approved.map((l) => l.quality_score || 0)), flagged: i.json.leads.filter((l) => l.status === 'Needs review').length,
    rejected: i.json.leads.filter((l) => l.status === 'Rejected').length } };
});`);
  w.execWorkflow('Post Campaign ready', '15_slack_notify');
  w.code('Ready updates', ['airtable'], `
const posted = Object.fromEntries($('Post Campaign ready').all().filter((i) => i.json && i.json.ref).map((i) => [i.json.ref, i.json]));
const updates = $('Campaign ready messages').all().map((i) => ({ id: i.json.ref, fields: {
  status: 'Ready', ready_at: new Date().toISOString(), slack_ts: (posted[i.json.ref] || {}).ts || null, slack_channel: (posted[i.json.ref] || {}).channel || null } }));
return M.airtable.updateBatches(updates).map((b) => ({ json: b }));`);
  w.atWrite('Set campaigns Ready', 'Campaigns', 'PATCH');
  // internal notification in a professional layout (plain text + HTML); the guard sends it to the sender only
  w.code('Campaign ready email', ['notifications'], `
const cfg = $('Config').first().json.cfg;
return $('Campaign ready messages').all().map((i) => {
  const m = M.notifications.campaignReadyEmail({ name: i.json.name, client: i.json.client, sender: i.json.sender, leadCount: i.json.approvedCount, avgScore: i.json.avgScore,
    avgQuality: i.json.avgQuality, flagged: i.json.flagged, rejected: i.json.rejected, samples: i.json.samples,
    controlUrl: cfg.n8nBaseUrl + '/webhook/app?p=campaign&id=' + i.json.ref });
  return { json: { ref: 'ready-' + i.json.ref, to: cfg.senderEmail || cfg.testProspectEmail, purpose: 'internal', fromName: 'Nexsale Lead Engine', subject: m.subject, body: m.body, html: m.html } };
});`);
  w.execWorkflow('Send Campaign ready email', '13_send_email');

  w.connect('Every 5 minutes', 'Config');
  w.connect('Run now', 'Config');
  w.chain('Config', 'Load Enriched leads', 'Load campaigns', 'Load clients', 'Claim', 'Anything to draft?');
  w.connect('Anything to draft?', 'Claim leads', 0);
  w.connect('Anything to draft?', 'Sourcing campaigns', 1);
  w.chain('Claim leads', 'Sequence requests', 'AI: write sequence', 'Quality requests', 'AI: quality check', 'Rewrite requests',
    'AI: rewrite sequence', 'Quality 2 requests', 'AI: quality check 2', 'Finalize sequences', 'Any emails?');
  w.connect('Any emails?', 'Create emails', 0);
  w.connect('Any emails?', 'Lead updates', 1);
  w.connect('Create emails', 'Lead updates');
  w.chain('Lead updates', 'Update leads', 'Campaign AI cost', 'Any cost?');
  w.connect('Any cost?', 'Update campaign cost', 0);
  w.connect('Any cost?', 'Sourcing campaigns', 1);
  w.connect('Update campaign cost', 'Sourcing campaigns');
  // ready check: strictly after drafting
  w.chain('Sourcing campaigns', 'Their leads', 'Ready campaigns', 'Approved emails', 'Campaign ready messages', 'Post Campaign ready', 'Ready updates',
    'Set campaigns Ready', 'Campaign ready email', 'Send Campaign ready email');
  return w;
}

module.exports = [aiEmails];
