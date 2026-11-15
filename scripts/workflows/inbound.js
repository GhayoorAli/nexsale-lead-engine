/** Module 9 (inbound leads), 10 (HubSpot CRM sync), 11 (Slack buttons), 12 (GDPR delete). */
const { Workflow, CFG } = require('../n8n_builder');

const HS_AUTH = [['Authorization', '=Bearer {{ $env.HUBSPOT_TOKEN }}']];
const UA = 'Mozilla/5.0 (compatible; NexsaleLeadEngine/1.0; public Impressum lookup)';

function inboundLeads() {
  const w = new Workflow('09_inbound_leads', 'Nexsale 09 – Inbound leads (quiz / Meta ads)', { description: 'Quiz or ad lead → dedupe → enrich → AI hot/warm/cold + 3-line call brief → call task + Slack + confirmation email.' });
  w.webhook('Inbound webhook', 'inbound-lead');
  w.at(0, 1);
  w.add('Quiz form (demo)', 'n8n-nodes-base.formTrigger', 2.2, {
    formTitle: 'In 60 Sekunden zu mehr Terminen', formDescription: 'Demo-Ersatz für das Web3Forms-Quiz und Meta Lead Ads.',
    formFields: { values: [
      { fieldLabel: 'Name', requiredField: true }, { fieldLabel: 'E-Mail', fieldType: 'email', requiredField: true }, { fieldLabel: 'Telefon' },
      { fieldLabel: 'Firma', requiredField: true }, { fieldLabel: 'Website' },
      { fieldLabel: 'In welcher Branche ist Ihr Unternehmen tätig?' }, { fieldLabel: 'Wie viele Mitarbeitende hat Ihr Unternehmen?' },
      { fieldLabel: 'Wie gewinnen Sie heute Neukunden?' }, { fieldLabel: 'Wie viele neue Termine pro Monat wünschen Sie sich?' },
      { fieldLabel: 'Welches monatliche Budget planen Sie für Vertrieb ein?' }, { fieldLabel: 'Wann möchten Sie starten?' },
    ] },
    responseMode: 'onReceived', options: { path: 'inbound-quiz', appendAttribution: false, respondWithOptions: { values: { formSubmittedText: 'Danke. Wir melden uns in Kürze telefonisch bei Ihnen.' } } },
  }, { webhookId: 'b6d1f6a2-0c0e-4f43-9d55-6b1e2a6c0009' });
  w.at(1, 0);
  w.config();
  w.code('Normalise', ['inbound'], `
const src = $('Inbound webhook').isExecuted ? $('Inbound webhook').first().json.body : $('Quiz form (demo)').first().json;
const r = M.inbound.normaliseInbound(src);
if (!r.ok) throw new Error('Inbound lead rejected: ' + r.errors.join(', '));
return [{ json: r }];`);
  w.atList('Existing leads', 'Leads', "\"OR(LOWER({email})='\" + $json.lead.email.replace(/'/g, '') + \"',LOWER({domain})='\" + String($json.lead.domain || '__none__').replace(/'/g, '') + \"')\"");
  w.atList('Clients', 'Clients', null);
  w.code('Upsert plan', ['inbound', 'airtable'], `
const n = $('Normalise').first().json;
const leads = M.airtable.fromItems($('Existing leads').all());
const ex = M.inbound.findExisting(n.lead, leads);
const now = new Date().toISOString();
const fields = Object.assign({}, n.lead, { sourced_at: now, status: 'Interested', next_send_at: null, sequence_finished: true, last_reply_category: null });
if (!fields.company_name) fields.company_name = n.lead.domain || n.lead.email;
if (ex.existing) {
  // already known: stop any running outreach sequence, keep the history
  return [{ json: { method: 'PATCH', body: { records: [{ id: ex.existing.id, fields: Object.assign({}, fields, { company_name: ex.existing.company_name || fields.company_name }) }], typecast: true }, existing: true, by: ex.by, was: ex.existing.status } }];
}
return [{ json: { method: 'POST', body: { records: [{ fields }], typecast: true }, existing: false } }];`);
  w.http('Save lead', { method: '={{ $json.method }}', url: `={{ ${CFG('airtableUrl')} }}/Leads`, headers: [['Authorization', '=Bearer {{ $env.AIRTABLE_PAT }}']], body: '$json.body', notes: 'Airtable: create or update the lead' });
  w.code('Pages to fetch', ['config'], `
const cfg = $('Config').first().json.cfg;
const lead = $('Save lead').first().json.records[0];
const d = lead.fields.domain;
return [{ json: { lead, home_url: M.config.webUrl(cfg, d, '/'), imp_url: M.config.webUrl(cfg, d, '/impressum') } }];`);
  const fetch = (name, url) => w.http(name, { method: 'GET', url: `={{ ${url} }}`, headers: [['User-Agent', UA]], fullResponse: true, neverError: true, text: true, timeout: 10000, continueOnFail: true });
  fetch('Homepage', "$('Pages to fetch').first().json.home_url");
  fetch('Impressum', "$('Pages to fetch').first().json.imp_url");
  w.code('Enrich', ['parseImpressum'], `
const p = $('Pages to fetch').first().json;
const body = (r) => String((r && (r.body !== undefined ? r.body : r.data)) || '');
const imp = $('Impressum').first().json;
const parsed = Number(imp.statusCode) === 200 ? M.parseImpressum.parseImpressum(body(imp), p.lead.fields.domain, p.lead.fields.company_name) : {};
const home = M.parseImpressum.stripHtml(body($('Homepage').first().json)).slice(0, 3000);
return [{ json: { ref: 'summary', prompt_id: 'company_summary', max_tokens: 300, vars: { company_name: p.lead.fields.company_name, city: p.lead.fields.city || '', homepage_text: home || '(keine Startseite)' }, parsed } }];`);
  w.execWorkflow('AI: company summary', '14_ai_call');
  w.code('Brief request', [], `
const p = $('Pages to fetch').first().json;
const s = $('AI: company summary').all().map((i) => i.json).find((x) => x && x.ref === 'summary');
return [{ json: { ref: 'brief', prompt_id: 'inbound_lead_brief', max_tokens: 400, summary: s && s.ok ? s.data.summary : '',
  vars: { contact_name: p.lead.fields.contact_name, company_name: p.lead.fields.company_name, company_summary: s && s.ok ? s.data.summary : '(unbekannt)', inbound_answers: p.lead.fields.inbound_answers || '(keine)' } } }];`);
  w.execWorkflow('AI: call brief', '14_ai_call');
  w.code('Task', ['inbound', 'schedule', 'airtable'], `
const n = $('Normalise').first().json;
const p = $('Pages to fetch').first().json;
const b = $('AI: call brief').all().map((i) => i.json).find((x) => x && x.ref === 'brief');
const summary = $('Brief request').first().json.summary;
const temperature = b && b.ok ? String(b.data.temperature).toLowerCase() : M.inbound.ruleTemperature(n.answers);
const brief = b && b.ok ? b.data.brief : 'Inbound-Lead von ' + p.lead.fields.company_name + '. Antworten: ' + (p.lead.fields.inbound_answers || '').replace(/\\n/g, '; ');
const due = M.inbound.taskDueAt(temperature, new Date(), M.schedule);
const parsed = $('Enrich').first().json.parsed || {};
return [{ json: { temperature, brief, due,
  task: { records: [{ fields: { key: 'Call inbound lead · ' + p.lead.fields.company_name, lead: [p.lead.id], lead_record_id: p.lead.id, type: 'Call inbound lead', due_at: due, summary: brief, status: 'Open', assigned_to: 'Sales caller' } }], typecast: true },
  lead: { records: [{ id: p.lead.id, fields: { inbound_temperature: temperature, company_summary: summary || null, register_number: parsed.register_number || null, legal_form: parsed.legal_form || null,
    contact_role: parsed.contact_role || null, score: { hot: 90, warm: 60, cold: 30 }[temperature] || 50 } }], typecast: true } } }];`);
  w.atWrite('Create call task', 'Tasks', 'POST', { body: "$('Task').first().json.task" });
  w.atWrite('Update lead', 'Leads', 'PATCH', { body: "$('Task').first().json.lead" });
  w.code('Caller message', ['slackMessages', 'reminders'], `
const t = $('Task').first().json;
const p = $('Pages to fetch').first().json;
const task = $('Create call task').first().json.records[0];
const m = M.slackMessages.inboundLead({ temperature: t.temperature, name: p.lead.fields.contact_name || p.lead.fields.email, company: p.lead.fields.company_name, phone: p.lead.fields.phone, brief: t.brief, due: M.reminders.formatBerlin(t.due), taskRecordId: task.id });
return [{ json: { ref: task.id, text: m.text, blocks: m.blocks } }];`);
  w.execWorkflow('Post to caller', '15_slack_notify');
  w.atWrite('Save Slack ts', 'Tasks', 'PATCH', { body: "{ records: [{ id: $('Post to caller').first().json.ref, fields: { slack_ts: $('Post to caller').first().json.ts, slack_channel: $('Post to caller').first().json.channel } }], typecast: true }" });
  w.code('Confirmation email', ['calendly', 'airtable', 'validateEmails'], `
const cfg = $('Config').first().json.cfg;
const p = $('Pages to fetch').first().json;
const client = M.airtable.fromItems($('Clients').all())[0] || {};
const link = M.calendly.bookingLink(client.calendly_link || cfg.calendlyLink, p.lead.id);
return [{ json: { ref: p.lead.id, to: p.lead.fields.email, purpose: 'inbound confirmation', subject: 'Danke für Ihre Anfrage',
  body: M.validateEmails.ensureFrame('vielen Dank für Ihre Anfrage. Wir rufen Sie in Kürze an. Wenn Sie lieber direkt einen Termin wählen möchten: ' + link,
    { contactName: p.lead.fields.contact_name || '', signature: M.validateEmails.buildSignature(client) }) } }];`);
  w.execWorkflow('Send confirmation (guarded)', '13_send_email');
  w.connect('Inbound webhook', 'Config');
  w.connect('Quiz form (demo)', 'Config');
  w.chain('Config', 'Normalise', 'Existing leads', 'Clients', 'Upsert plan', 'Save lead', 'Pages to fetch', 'Homepage', 'Impressum', 'Enrich', 'AI: company summary',
    'Brief request', 'AI: call brief', 'Task', 'Create call task', 'Update lead', 'Caller message', 'Post to caller', 'Save Slack ts', 'Confirmation email', 'Send confirmation (guarded)');
  return w;
}

function crmSync() {
  const w = new Workflow('10_crm_sync', 'Nexsale 10 – CRM sync (HubSpot)', { description: 'Leads in Interested / Meeting booked / Meeting held / No-show → one contact, company and deal each. A later Not interested / STOP closes the existing deal (Closed lost). Search first, so re-runs never duplicate.' });
  w.webhook('Sync now', 'crm-sync');
  w.at(0, 1);
  w.schedule('Every 15 minutes', { field: 'minutes', minutesInterval: 15 });
  w.at(1, 0);
  w.config();
  w.atList('Leads to sync', 'Leads', "\"AND(OR({status}='Interested',{status}='Meeting booked',{status}='Meeting held',{status}='No-show',AND(OR({status}='Not interested',{status}='Unsubscribed'),{hubspot_deal_id}!='')),{crm_synced_status}!={status})\"", { maxRecords: 10, maxPages: 1, notes: 'Not interested / Unsubscribed only when a deal already exists: closes it, never creates one' });
  w.atList('Meetings', 'Meetings', "\"{status}!='Cancelled'\"");
  w.atList('Campaigns', 'Campaigns', null);
  w.atList('Clients', 'Clients', null);
  w.code('Plan', ['airtable', 'crm'], `
const leads = M.airtable.fromItems($('Leads to sync').all());
const meetings = M.airtable.fromItems($('Meetings').all());
const camps = M.airtable.fromItems($('Campaigns').all());
const clients = M.airtable.fromItems($('Clients').all());
return leads.map((l) => {
  const c = camps.find((x) => x.id === l.campaign_record_id) || {};
  const client = clients.find((k) => k.id === c.client_record_id) || clients[0] || {};
  const m = meetings.filter((x) => x.lead_record_id === l.id).sort((a, b) => String(b.start_time).localeCompare(String(a.start_time)))[0] || null;
  return { json: { lead: l, meeting: m, campaign: c.name || l.lead_type || '', owner: client.hubspot_owner_id || '', dealname: M.crm.dealName(l) } };
});`);
  const hs = (name, method, url, body, extra) => w.http(name, Object.assign({ method, url, headers: HS_AUTH, body, batch: { size: 1, interval: 150 } }, extra || {}));
  hs('Search contact', 'POST', `={{ ${CFG('hubspotUrl')} }}/crm/v3/objects/contacts/search`, "{ filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: String($json.lead.email).toLowerCase() }] }], limit: 1 }");
  w.code('Contact upsert', ['crm'], `
const p = $('Plan').item.json;
const id = M.crm.firstResultId($json);
return { json: M.crm.upsertPlan(id, 'contacts', M.crm.contactProps(p.lead, { create: !id })) };`, { each: true });
  hs('Upsert contact', '={{ $json.method }}', `={{ ${CFG('hubspotUrl')} }}{{ $json.path }}`, '$json.body');
  hs('Search company', 'POST', `={{ ${CFG('hubspotUrl')} }}/crm/v3/objects/companies/search`, "{ filterGroups: [{ filters: [{ propertyName: 'domain', operator: 'EQ', value: String($('Plan').item.json.lead.domain || '').toLowerCase() }] }], limit: 1 }");
  w.code('Company upsert', ['crm'], `
const p = $('Plan').item.json;
return { json: M.crm.upsertPlan(M.crm.firstResultId($json), 'companies', M.crm.companyProps(p.lead)) };`, { each: true });
  hs('Upsert company', '={{ $json.method }}', `={{ ${CFG('hubspotUrl')} }}{{ $json.path }}`, '$json.body');
  hs('Contact ↔ company', 'PUT', `={{ ${CFG('hubspotUrl')} }}/crm/v4/objects/contact/{{ $('Upsert contact').item.json.id }}/associations/default/company/{{ $('Upsert company').item.json.id }}`, null);
  hs('Search deal', 'POST', `={{ ${CFG('hubspotUrl')} }}/crm/v3/objects/deals/search`, "{ filterGroups: [{ filters: [{ propertyName: 'dealname', operator: 'EQ', value: $('Plan').item.json.dealname }] }], limit: 1 }");
  w.code('Deal upsert', ['crm'], `
const p = $('Plan').item.json;
return { json: M.crm.upsertPlan(M.crm.firstResultId($json), 'deals', M.crm.dealProps(p.lead, p.meeting, p.owner)) };`, { each: true });
  hs('Upsert deal', '={{ $json.method }}', `={{ ${CFG('hubspotUrl')} }}{{ $json.path }}`, '$json.body');
  hs('Deal ↔ contact', 'PUT', `={{ ${CFG('hubspotUrl')} }}/crm/v4/objects/deal/{{ $('Upsert deal').item.json.id }}/associations/default/contact/{{ $('Upsert contact').item.json.id }}`, null);
  hs('Deal ↔ company', 'PUT', `={{ ${CFG('hubspotUrl')} }}/crm/v4/objects/deal/{{ $('Upsert deal').item.json.id }}/associations/default/company/{{ $('Upsert company').item.json.id }}`, null);
  w.code('Note', ['crm'], `
const p = $('Plan').item.json;
const text = 'Status: ' + p.lead.status + (p.meeting ? ' · Termin: ' + p.meeting.start_time : '') + '\\nQuelle: ' + p.campaign + ' (' + (p.lead.source || '') + ')\\n' + (p.lead.meeting_brief || p.lead.company_summary || '');
return { json: M.crm.noteProps(text, new Date().toISOString(), $('Upsert deal').item.json.id) };`, { each: true });
  hs('Add note', 'POST', `={{ ${CFG('hubspotUrl')} }}/crm/v3/objects/notes`, '$json');
  w.code('Airtable update', ['airtable'], `
const plans = $('Plan').all();
const c = $('Upsert contact').all(), co = $('Upsert company').all(), d = $('Upsert deal').all();
return M.airtable.updateBatches(plans.map((p, i) => ({ id: p.json.lead.id, fields: {
  hubspot_contact_id: String(c[i].json.id), hubspot_company_id: String(co[i].json.id), hubspot_deal_id: String(d[i].json.id), crm_synced_status: p.json.lead.status,
} }))).map((b) => ({ json: b }));`);
  w.atWrite('Save HubSpot ids', 'Leads', 'PATCH');
  w.connect('Sync now', 'Config');
  w.connect('Every 15 minutes', 'Config');
  w.chain('Config', 'Leads to sync', 'Meetings', 'Campaigns', 'Clients', 'Plan', 'Search contact', 'Contact upsert', 'Upsert contact', 'Search company', 'Company upsert',
    'Upsert company', 'Contact ↔ company', 'Search deal', 'Deal upsert', 'Upsert deal', 'Deal ↔ contact', 'Deal ↔ company', 'Note', 'Add note', 'Airtable update', 'Save HubSpot ids');
  return w;
}

function slackActions() {
  const w = new Workflow('11_slack_actions', 'Nexsale 11 – Slack buttons (click 3 and approvals)', { description: 'Verifies the Slack signature, runs the action, then edits the message to "<Action> by <user> at <time>".' });
  w.webhook('Slack interactivity', 'slack-actions', { rawBody: true });
  // the Control Center (16) triggers the same actions here, so Slack and the Control Center always behave identically;
  // local only (the tunnel lets only /webhook/slack-actions through) and authenticated with CONTROL_PASSWORD
  w.at(0, 2);
  w.webhook('Control action', 'control-action');
  w.at(1, 0);
  w.config();
  w.code('Verify + parse', ['slackSignature', 'slackMessages'], `
const crypto = require('crypto');
if ($('Control action').isExecuted) {
  const req = $('Control action').first().json;
  const key = String((req.headers || {})['x-control-key'] || '');
  const expected = String($env.CONTROL_PASSWORD || '');
  if (!expected || key.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(key), Buffer.from(expected))) throw new Error('Control action rejected: wrong or missing key');
  const b = req.body || {};
  const action = String(b.action || '');
  if (!action) return [];
  const when = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }).format(new Date());
  return [{ json: { route: action.startsWith('sort_') ? 'sort' : action, action, recordId: String(b.recordId || ''), user: String(b.user || 'Control Center'), when, channel: null, ts: null, original: null } }];
}
const item = $('Slack interactivity').first();
let raw = '';
try { raw = (await this.helpers.getBinaryDataBuffer(0, 'data')).toString('utf8'); } catch (e) { raw = ''; }
const h = item.json.headers || {};
const v = M.slackSignature.verifySlackSignature({ signingSecret: $env.SLACK_SIGNING_SECRET, timestamp: h['x-slack-request-timestamp'], signature: h['x-slack-signature'], rawBody: raw, crypto });
if (!v.ok) throw new Error('Slack signature rejected: ' + v.reason);
const p = M.slackSignature.parseSlackPayload(raw);
if (!p || !p.actions || !p.actions[0]) return [];
const a = M.slackMessages.parseActionValue(p.actions[0].value);
const user = (p.user && (p.user.username || p.user.name)) || 'someone';
const route = a.action.startsWith('sort_') ? 'sort' : a.action;
const when = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }).format(new Date());
return [{ json: { route, action: a.action, recordId: a.recordId, user, when, channel: (p.channel && p.channel.id) || (p.container && p.container.channel_id), ts: (p.message && p.message.ts) || (p.container && p.container.message_ts), original: p.message || {} } }];`);
  w.switchOn('Action', "$('Verify + parse').first().json.route", ['approve_launch', 'reply_approve', 'reply_reject', 'sort', 'task_called', 'task_not_reached', 'meeting_held', 'meeting_noshow', 'meeting_cancel']);
  const done = (name, label) => w.code(name, ['slackMessages'], `
const a = $('Verify + parse').first().json;
const label = ${label};
const m = M.slackMessages.resolvedMessage(a.original, label, a.user, a.when);
return [{ json: { ref: a.recordId, update_ts: a.ts, channel: a.channel, text: m.text, blocks: m.blocks } }];`);
  // approve and launch (click 3)
  w.at(4, -3);
  w.atWrite('Campaign → Launch', 'Campaigns', 'PATCH', { body: "{ records: [{ id: $('Verify + parse').first().json.recordId, fields: { status: 'Launch', launched_by: $('Verify + parse').first().json.user } }], typecast: true }" });
  w.kick('Run launch checks', 'campaign-launch', "{ campaign_record_id: $('Verify + parse').first().json.recordId, approved_by: $('Verify + parse').first().json.user }");
  done('Launch clicked', "'Approve and launch'");
  // approve and send a suggested reply
  w.at(4, -2);
  w.atGet('Load reply', 'Replies', "$('Verify + parse').first().json.recordId");
  w.atGet('Load lead', 'Leads', "$('Load reply').first().json.fields.lead_record_id");
  w.code('Approved answer', [], `
const r = $('Load reply').first().json.fields;
const l = $('Load lead').first().json.fields;
if (r.reply_approved) throw new Error('Reply already answered – not sending twice');
return [{ json: { ref: $('Load reply').first().json.id, to: l.email, subject: 'Re: ' + String(r.subject || '').replace(/^(\\s*(\\[TEST\\]|Re:|AW:)\\s*)+/i, ''), body: r.suggested_reply, threadId: r.thread_id || '', purpose: 'reply' } }];`);
  w.execWorkflow('Send answer (guarded)', '13_send_email', { alwaysOutputData: false });
  w.atWrite('Reply approved', 'Replies', 'PATCH', { body: "{ records: [{ id: $('Load reply').first().json.id, fields: { reply_approved: true, handled_at: new Date().toISOString(), handled_by: $('Verify + parse').first().json.user } }], typecast: true }" });
  done('Approve clicked', "'Approved'");
  // reject
  w.at(4, -1);
  w.atWrite('Reply rejected', 'Replies', 'PATCH', { body: "{ records: [{ id: $('Verify + parse').first().json.recordId, fields: { reply_approved: false, handled_at: new Date().toISOString(), handled_by: 'rejected by ' + $('Verify + parse').first().json.user } }], typecast: true }" });
  done('Reject clicked', "'Rejected'");
  // sort an unclear reply → 07 runs the branch with the human category
  w.at(4, 0);
  w.kick('Re-run reply branch', 'reply-ingest', "{ reprocess_reply_id: $('Verify + parse').first().json.recordId, handled_by: $('Verify + parse').first().json.user, forced_category: ({ sort_interested: 'Interested', sort_later: 'Later', sort_not_interested: 'Not interested', sort_unsubscribe: 'Unsubscribe' })[$('Verify + parse').first().json.action] }");
  done('Sort clicked', "'Sorted as ' + ({ sort_interested: 'Interested', sort_later: 'Later', sort_not_interested: 'Not interested', sort_unsubscribe: 'Unsubscribe' })[a.action]");
  // inbound tasks
  w.at(4, 1);
  w.atWrite('Task done', 'Tasks', 'PATCH', { body: "{ records: [{ id: $('Verify + parse').first().json.recordId, fields: { status: 'Done' } }], typecast: true }" });
  done('Called clicked', "'Marked called'");
  w.at(4, 2);
  w.atWrite('Task +2 h', 'Tasks', 'PATCH', { body: "{ records: [{ id: $('Verify + parse').first().json.recordId, fields: { due_at: new Date(Date.now() + 7200000).toISOString() } }], typecast: true }" });
  done('Not reached clicked', "'Not reached, rescheduled +2 h'");
  // meeting held / no-show
  w.at(4, 3);
  w.atGet('Load meeting', 'Meetings', "$('Verify + parse').first().json.recordId");
  w.code('Meeting outcome', [], `
const a = $('Verify + parse').first().json;
const m = $('Load meeting').first().json;
const held = a.action === 'meeting_held';
const out = { meeting: { records: [{ id: m.id, fields: { status: held ? 'Held' : 'No-show' } }], typecast: true },
  lead: { records: [{ id: m.fields.lead_record_id, fields: { status: held ? 'Meeting held' : 'No-show' } }], typecast: true },
  task: held ? null : { records: [{ fields: { key: 'Call no-show · ' + m.fields.key, lead: [m.fields.lead_record_id], lead_record_id: m.fields.lead_record_id, type: 'Call no-show', due_at: new Date(Date.now() + 3600000).toISOString(), status: 'Open', summary: 'Termin nicht wahrgenommen – bitte anrufen und neu terminieren.' } }], typecast: true } };
return [{ json: out }];`);
  w.atWrite('Meeting status', 'Meetings', 'PATCH', { body: '$json.meeting' });
  w.atWrite('Lead status', 'Leads', 'PATCH', { body: "$('Meeting outcome').first().json.lead" });
  w.ifTrue('No-show?', "!!$('Meeting outcome').first().json.task");
  w.atWrite('Call task', 'Tasks', 'POST', { body: "$('Meeting outcome').first().json.task" });
  w.kick('CRM stage update', 'crm-sync', "{ lead_record_id: $('Meeting outcome').first().json.lead.records[0].id }");
  done('Meeting clicked', "a.action === 'meeting_held' ? 'Marked held' : 'Marked no-show'");
  // cancel an upcoming meeting (Control Center "Termin absagen"): Airtable Cancelled, then Calendly (the invitee gets
  // Calendly's cancellation email), lead back to Interested, HubSpot stage follows. Calendly refusing never hides the cancel.
  w.at(4, 4);
  w.atGet('Load meeting (cancel)', 'Meetings', "$('Verify + parse').first().json.recordId");
  w.atGet('Load lead (cancel)', 'Leads', "$('Load meeting (cancel)').first().json.fields.lead_record_id");
  w.code('Cancel plan', ['calendly'], `
const m = $('Load meeting (cancel)').first().json;
if (!['Booked', 'Reminded'].includes(m.fields.status)) throw new Error('Meeting ' + m.id + ' is ' + m.fields.status + ' – only booked meetings can be cancelled');
const l = $('Load lead (cancel)').first().json;
const req = M.calendly.cancellationRequest({ id: m.id, calendly_event_id: m.fields.calendly_event_id }, 'Der Termin wurde von Nexsale abgesagt. Wir melden uns für einen neuen Termin.');
return [{ json: Object.assign(req, { company: l.fields.company_name || '', when: String(m.fields.start_time || '').slice(0, 16).replace('T', ' '),
  meeting: { records: [{ id: m.id, fields: { status: 'Cancelled' } }], typecast: true },
  lead: { records: [{ id: l.id, fields: { status: 'Interested' } }], typecast: true } }) }];`);
  w.atWrite('Meeting → Cancelled', 'Meetings', 'PATCH', { body: "$('Cancel plan').first().json.meeting" });
  w.http('Cancel in Calendly', {
    method: 'POST', url: `={{ ${CFG('calendlyApiUrl')} }}{{ $('Cancel plan').first().json.path }}`, headers: [['Authorization', '=Bearer {{ $env.CALENDLY_TOKEN }}']],
    body: "$('Cancel plan').first().json.body", fullResponse: true, neverError: true, continueOnFail: true,
    notes: 'Calendly API: POST /scheduled_events/{uuid}/cancellation (201 = cancelled)',
  });
  w.code('Calendly result', ['calendly'], `
const p = $('Cancel plan').first().json;
const r = $('Cancel in Calendly').first().json;
return [{ json: { ok: !!p.uuid && M.calendly.cancellationOk(r), problem: p.uuid ? M.calendly.cancellationProblem(r) : 'no Calendly event id stored' } }];`);
  w.atWrite('Lead → Interested', 'Leads', 'PATCH', { body: "$('Cancel plan').first().json.lead" });
  w.kick('CRM after cancel', 'crm-sync', "{ lead_record_id: $('Cancel plan').first().json.lead.records[0].id }");
  done('Cancel clicked', "(() => { const p = $('Cancel plan').first().json, r = $('Calendly result').first().json; return 'Meeting with ' + p.company + ' on ' + p.when + ' cancelled' + (r.ok ? ' (also in Calendly, the invitee was notified)' : ' – *please cancel it in Calendly too* (Calendly: ' + r.problem + ')'); })()");
  w.at(16, 0);
  w.execWorkflow('Update Slack message', '15_slack_notify');

  // verify first: getBinaryDataBuffer(0) reads the raw body of THIS node's input, which must be the webhook
  w.chain('Slack interactivity', 'Verify + parse', 'Config', 'Action');
  w.connect('Control action', 'Verify + parse');
  w.connect('Action', 'Campaign → Launch', 0);
  w.connect('Action', 'Load reply', 1);
  w.connect('Action', 'Reply rejected', 2);
  w.connect('Action', 'Re-run reply branch', 3);
  w.connect('Action', 'Task done', 4);
  w.connect('Action', 'Task +2 h', 5);
  w.connect('Action', 'Load meeting', 6);
  w.connect('Action', 'Load meeting', 7);
  w.chain('Campaign → Launch', 'Run launch checks', 'Launch clicked', 'Update Slack message');
  w.chain('Load reply', 'Load lead', 'Approved answer', 'Send answer (guarded)', 'Reply approved', 'Approve clicked', 'Update Slack message');
  w.chain('Reply rejected', 'Reject clicked', 'Update Slack message');
  w.chain('Re-run reply branch', 'Sort clicked', 'Update Slack message');
  w.chain('Task done', 'Called clicked', 'Update Slack message');
  w.chain('Task +2 h', 'Not reached clicked', 'Update Slack message');
  w.chain('Load meeting', 'Meeting outcome', 'Meeting status', 'Lead status', 'No-show?');
  w.connect('No-show?', 'Call task', 0);
  w.connect('No-show?', 'CRM stage update', 1);
  w.connect('Call task', 'CRM stage update');
  w.connect('Action', 'Load meeting (cancel)', 8);
  w.chain('Load meeting (cancel)', 'Load lead (cancel)', 'Cancel plan', 'Meeting → Cancelled', 'Cancel in Calendly', 'Calendly result', 'Lead → Interested', 'CRM after cancel', 'Cancel clicked', 'Update Slack message');
  w.chain('CRM stage update', 'Meeting clicked', 'Update Slack message');
  return w;
}

function deleteLead() {
  const w = new Workflow('12_delete_lead', 'Nexsale 12 – GDPR delete lead', { description: 'Webhook with an email: deletes the lead with its emails, replies, meetings, tasks and logs; keeps only a Blocklist entry.' });
  w.webhook('Delete request', 'delete-lead', { responseMode: 'lastNode' });
  w.config();
  w.code('Validate', [], `
const e = String((($('Delete request').first().json.body || {}).email) || '').trim().toLowerCase();
if (!/^[^@\\s']+@[^@\\s']+\\.[^@\\s']+$/.test(e)) throw new Error('delete-lead: a valid email is required');
return [{ json: { email: e } }];`);
  w.atList('Leads', 'Leads', "\"LOWER({email})='\" + $json.email + \"'\"");
  w.code('Child filter', ['airtable'], `
const ids = M.airtable.fromItems($('Leads').all()).map((l) => l.id);
return [{ json: { formula: M.airtable.inIds('lead_record_id', ids) } }];`);
  ['Emails', 'Replies', 'Meetings', 'Tasks', 'Logs'].forEach((t) => w.atList(t, t, "$('Child filter').first().json.formula"));
  w.atList('Blocklist', 'Blocklist', "\"LOWER({value})='\" + $('Validate').first().json.email + \"'\"");
  w.code('Deletion plan', ['airtable', 'gdpr'], `
const data = {}; ['Leads', 'Emails', 'Replies', 'Meetings', 'Tasks', 'Logs', 'Blocklist'].forEach((t) => (data[t.toLowerCase()] = M.airtable.fromItems($(t).all())));
const plan = M.gdpr.deletionPlan($('Validate').first().json.email, data);
const items = [];
['Emails', 'Replies', 'Meetings', 'Tasks', 'Logs', 'Leads'].forEach((t) => M.airtable.chunk(plan.delete[t]).forEach((ids) => items.push({ json: { table: t, query: ids.map((id) => 'records[]=' + id).join('&'), count: ids.length, plan } })));
return items.length ? items : [{ json: { table: null, plan } }];`);
  w.ifTrue('Anything to delete?', '!!$json.table');
  w.http('Delete records', { method: 'DELETE', url: `={{ ${CFG('airtableUrl')} }}/{{ $json.table }}?{{ $json.query }}`, headers: [['Authorization', '=Bearer {{ $env.AIRTABLE_PAT }}']], batch: { size: 1, interval: 220 }, notes: 'Airtable: delete (children first, lead last)' });
  w.code('Blocklist entry', [], `
const plan = $('Deletion plan').first().json.plan;
return [{ json: { needed: !!plan.blocklist, body: plan.blocklist ? { records: [{ fields: plan.blocklist }], typecast: true } : null, plan } }];`);
  w.ifTrue('Add to Blocklist?', '$json.needed');
  w.atWrite('Keep Blocklist entry', 'Blocklist', 'POST', { body: "$('Blocklist entry').first().json.body" });
  w.code('Summary', [], `
const plan = $('Blocklist entry').first().json.plan;
const counts = Object.fromEntries(Object.entries(plan.delete).map(([k, v]) => [k, v.length]));
return [{ json: { ok: true, email: plan.email, deleted: counts, blocklisted: true } }];`);
  w.chain('Delete request', 'Config', 'Validate', 'Leads', 'Child filter', 'Emails', 'Replies', 'Meetings', 'Tasks', 'Logs', 'Blocklist', 'Deletion plan', 'Anything to delete?');
  w.connect('Anything to delete?', 'Delete records', 0);
  w.connect('Anything to delete?', 'Blocklist entry', 1);
  w.connect('Delete records', 'Blocklist entry');
  w.connect('Blocklist entry', 'Add to Blocklist?');
  w.connect('Add to Blocklist?', 'Keep Blocklist entry', 0);
  w.connect('Add to Blocklist?', 'Summary', 1);
  w.connect('Keep Blocklist entry', 'Summary');
  return w;
}

module.exports = [inboundLeads, crmSync, slackActions, deleteLead];
