/** Module 7 – replies (07), Gmail inbox poller (07a), Calendly (07b), reminders (07c). */
const { Workflow, CFG } = require('../n8n_builder');

function replies() {
  const w = new Workflow('07_replies', 'Nexsale 07 – Reply sorting', { description: 'Match → stop sequence → rules/AI category → branch. Interested ≥ 0.85 is answered automatically with the Calendly link.' });
  w.webhook('Reply webhook', 'reply-ingest');
  w.config();
  w.code('Normalise', ['replies'], `
const cfg = $('Config').first().json.cfg;
const b = $('Reply webhook').first().json.body || {};
if (b.reprocess_reply_id) return [{ json: { mode: 'reprocess', reply_id: b.reprocess_reply_id, forced_category: b.forced_category, handled_by: b.handled_by || 'Slack' } }];
const r = M.replies.normaliseIncoming(b);
if (!r.from_email || (cfg.senderEmail && r.from_email === cfg.senderEmail && !M.replies.detectBounce(r))) return []; // our own sent mail
const bounce = M.replies.detectBounce(r);
return [{ json: { mode: 'new', reply: r, bounce, bounced: bounce ? M.replies.bouncedAddress(r) : '' } }];`);
  w.ifTrue('Re-sorted in Slack?', "$json.mode === 'reprocess'");
  w.at(4, 1);
  w.atGet('Load reply', 'Replies', "$('Normalise').first().json.reply_id");
  w.code('Reply from record', [], `
const n = $('Normalise').first().json;
const r = $('Load reply').first().json;
const f = r.fields || {};
return [{ json: { mode: 'reprocess', reply_record_id: r.id, forced: { category: n.forced_category, confidence: 1, return_date: null, summary: 'Von ' + n.handled_by + ' in Slack sortiert', by: 'human' },
  handled_by: n.handled_by, lead_hint: f.lead_record_id,
  reply: { message_id: f.gmail_message_id || '', thread_id: f.thread_id || '', from_email: f.from_email || '', subject: f.subject || '', body: f.body || '', body_clean: f.body || '', received_at: f.received_at } } }];`);
  w.at(5, 0);
  w.atList('Emails in thread', 'Emails', "\"AND({thread_id}!='',{thread_id}='\" + String($json.reply.thread_id || '').replace(/'/g, '') + \"')\"", { each: false });
  w.code('Lead lookup', ['airtable'], `
const ctx = $('Reply from record').isExecuted ? $('Reply from record').first().json : $('Normalise').first().json;
const emails = M.airtable.fromItems($('Emails in thread').all());
const ids = emails.map((e) => e.lead_record_id).concat(ctx.lead_hint ? [ctx.lead_hint] : []).filter(Boolean);
const addrs = [ctx.reply.from_email, ctx.bounced].filter(Boolean).map((a) => String(a).toLowerCase().replace(/'/g, ''));
const parts = ids.map((id) => "RECORD_ID()='" + id + "'").concat(addrs.map((a) => "LOWER({email})='" + a + "'"));
return [{ json: Object.assign({}, ctx, { thread_emails: emails, formula: parts.length ? 'OR(' + parts.join(',') + ')' : "{email}='__none__'" }) }];`);
  w.atList('Candidate leads', 'Leads', '$json.formula');
  w.code('Match + rules', ['replies', 'airtable'], `
const ctx = $('Lead lookup').first().json;
const leads = M.airtable.fromItems($('Candidate leads').all());
const emails = ctx.thread_emails.map((e) => ({ lead_record_id: e.lead_record_id, thread_id: e.thread_id }));
let match = ctx.lead_hint ? { lead: leads.find((l) => l.id === ctx.lead_hint) || null, by: 'reply record' } : M.replies.matchReplyToLead(ctx.reply, leads, emails);
if (!match.lead && ctx.bounce && ctx.bounced) match = { lead: leads.find((l) => String(l.email).toLowerCase() === ctx.bounced) || null, by: 'bounced address' };
let cls = ctx.forced || null;
if (!cls && ctx.bounce) cls = { category: 'Bounce', confidence: 1, return_date: null, summary: 'Unzustellbar (' + (ctx.bounced || 'unbekannt') + ')', by: 'rule' };
if (!cls) cls = M.replies.ruleClassify(ctx.reply, new Date().toISOString());
const thread = ctx.thread_emails.filter((e) => e.status === 'Sent').sort((a, b) => b.step - a.step)[0] || {};
return [{ json: Object.assign({}, ctx, { lead: match.lead, matched_by: match.by, cls, needs_ai: !cls, last_sent: thread }) }];`);
  w.code('Classifier request', [], `
const j = $('Match + rules').first().json;
if (!j.needs_ai) return [];
return [{ json: { ref: 'reply', prompt_id: 'reply_classifier', max_tokens: 300, vars: { subject: j.reply.subject, body: j.reply.body_clean || j.reply.body, today: new Date().toISOString().slice(0, 10) } } }];`, { alwaysOutputData: true });
  w.execWorkflow('AI: classify reply', '14_ai_call');
  w.code('Decide branch', ['replies', 'calendly'], `
const cfg = $('Config').first().json.cfg;
const j = $('Match + rules').first().json;
const ai = $('AI: classify reply').all().map((i) => i.json).find((x) => x && x.ref === 'reply');
let cls = j.cls;
if (!cls) cls = ai && ai.ok ? Object.assign({ by: 'ai' }, ai.data) : { category: 'Unclear', confidence: 0, return_date: null, summary: 'KI-Ausgabe ungültig', by: 'ai' };
const now = new Date().toISOString();
const route = cls.category === 'Bounce' ? { branch: 'Bounce', leadStatus: 'Bounced', block: true } : M.replies.routeReply(cls, cfg, now);
if (!j.lead) route.branch = j.reply.bulk ? 'Ignored' : 'Unmatched'; // newsletters without a lead: stored, no Slack noise
const lead = j.lead || {};
const leadFields = { last_reply_category: cls.category === 'Unclear' ? null : cls.category, status: route.leadStatus };
if (route.branch === 'Out of office') { leadFields.next_send_at = route.resumeAt; leadFields.status = 'Contacted'; }
else { leadFields.next_send_at = null; }
if (route.branch === 'Later') leadFields.follow_up_at = route.followUpAt;
if (route.branch === 'Bounce') leadFields.bounced_at = now;
const replyFields = {
  key: (lead.company_name || j.reply.from_email) + ' · ' + now.slice(0, 16), lead: lead.id ? [lead.id] : undefined, lead_record_id: lead.id || '',
  received_at: j.reply.received_at, from_email: j.reply.from_email, subject: j.reply.subject, body: j.reply.body,
  category: cls.category, ai_confidence: Number(cls.confidence) || 0, classified_by: cls.by, summary: cls.summary, branch: route.branch,
  thread_id: j.reply.thread_id, gmail_message_id: j.reply.message_id,
};
if (j.handled_by && j.mode === 'reprocess') replyFields.handled_by = j.handled_by;
const blockValue = route.block ? (route.branch === 'Bounce' ? (j.bounced || lead.email) : lead.email) : null;
return [{ json: { route, cls, lead, reply: j.reply, last_sent: j.last_sent, mode: j.mode,
  reply_write: j.reply_record_id ? { method: 'PATCH', body: { records: [{ id: j.reply_record_id, fields: replyFields }], typecast: true } } : { method: 'POST', body: { records: [{ fields: replyFields }], typecast: true } },
  lead_write: lead.id ? { records: [{ id: lead.id, fields: leadFields }], typecast: true } : null,
  block: blockValue ? { records: [{ fields: { value: String(blockValue).toLowerCase(), reason: route.branch === 'Bounce' ? 'Bounced' : 'Unsubscribed (' + cls.by + ')', added_at: now } }], typecast: true } : null,
  calendly: M.calendly.bookingLink(cfg.calendlyLink, lead.id),
} }];`);
  w.http('Save reply', {
    method: '={{ $json.reply_write.method }}', url: `={{ ${CFG('airtableUrl')} }}/Replies`, headers: [['Authorization', '=Bearer {{ $env.AIRTABLE_PAT }}']],
    body: "$('Decide branch').first().json.reply_write.body", notes: 'Airtable: create (or update when re-sorted in Slack) the Replies record',
  });
  w.ifTrue('Lead matched?', "!!$('Decide branch').first().json.lead_write");
  w.atWrite('Stop sequence + status', 'Leads', 'PATCH', { body: "$('Decide branch').first().json.lead_write" });
  w.ifTrue('Blocklist?', "!!$('Decide branch').first().json.block");
  w.atWrite('Add to Blocklist', 'Blocklist', 'POST', { body: "$('Decide branch').first().json.block" });
  w.switchOn('Branch', "$('Decide branch').first().json.route.branch", ['Interested', 'Later', 'Unsure', 'Not interested', 'Unsubscribe', 'Out of office', 'Bounce', 'Unmatched', 'Question', 'Referral']);

  // Interested
  w.at(16, -2);
  w.atList('Answer clients', 'Clients', null);
  w.atList('Answer campaign', 'Campaigns', "\"RECORD_ID()='\" + String($('Decide branch').first().json.lead.campaign_record_id || '__none__') + \"'\"");
  w.code('Answer request', ['airtable', 'validateEmails', 'calendly'], `
const cfg = $('Config').first().json.cfg;
const d = $('Decide branch').first().json;
const camp = M.airtable.fromItems($('Answer campaign').all())[0] || {};
const clients = M.airtable.fromItems($('Answer clients').all());
const client = clients.find((k) => k.id === camp.client_record_id) || clients.find((k) => k.is_default) || clients[0] || {};
// the CLIENT's own booking link (client campaigns book into the client's calendar), tagged with the lead id
const calendly = M.calendly.bookingLink(client.calendly_link || cfg.calendlyLink, d.lead.id);
const frame = { frame: true, contactName: d.lead.contact_name || '', contactSalutation: d.lead.contact_salutation || '', senderName: client.sender_name || '', signature: M.validateEmails.buildSignature(client) };
return [{ json: { ref: 'answer', prompt_id: 'interested_reply', max_tokens: 400, frame, calendly, qualifying: String(client.qualifying_questions || '').trim(), validate_opts: Object.assign({ calendlyLink: calendly }, frame),
  vars: { calendly_link: calendly, sender_name: client.sender_name || '', offer: M.validateEmails.offerText(client, camp.industry), writing_notes: String(client.writing_notes || '').trim() || '(keine)', contact_name: d.lead.contact_name || '',
    company_name: d.lead.company_name || '', reply_body: d.reply.body_clean || d.reply.body } } }];`);
  w.execWorkflow('AI: answer', '14_ai_call');
  w.code('Answer', ['validateEmails'], `
const d = $('Decide branch').first().json;
const a = $('AI: answer').all().map((i) => i.json).find((x) => x && x.ref === 'answer');
const req = $('Answer request').first().json;
let body = a && a.ok ? a.data.body : M.validateEmails.ensureFrame('vielen Dank für Ihre Rückmeldung. Gerne stelle ich Ihnen unser Vorgehen in einem kurzen Gespräch von 15 Minuten vor. Hier können Sie einen passenden Termin wählen: ' + req.calendly + '\\n\\nPasst Ihnen einer der Termine?', req.frame);
// the client's qualifying questions (e.g. object size, contract end) go in before the sign-off, so the meeting is pre-qualified
if (req.qualifying) body = M.validateEmails.ensureFrame(M.validateEmails.messageText(body) + '\\n\\nDamit ich das Gespräch gut vorbereiten kann, gern vorab kurz: ' + req.qualifying, req.frame);
const saved = $('Save reply').first().json.records[0];
return [{ json: { reply_record_id: saved.id, body, auto: !!d.route.autoSend,
  update: { records: [{ id: saved.id, fields: { suggested_reply: body } }], typecast: true } } }];`);
  w.atWrite('Save suggested reply', 'Replies', 'PATCH', { body: "$('Answer').first().json.update" });
  w.ifTrue('Confidence ≥ 0.85?', "$('Answer').first().json.auto");
  w.code('Answer email', [], `
const d = $('Decide branch').first().json;
const a = $('Answer').first().json;
const subj = String(d.reply.subject || d.last_sent.subject_sent || '').replace(/^(\\s*(\\[TEST\\]|Re:|AW:)\\s*)+/i, '');
return [{ json: { ref: a.reply_record_id, to: d.lead.email, subject: 'Re: ' + subj, body: a.body, threadId: d.reply.thread_id || d.last_sent.thread_id || '', purpose: 'reply' } }];`);
  w.execWorkflow('Send answer (guarded)', '13_send_email', { alwaysOutputData: false });
  w.code('Mark answered', [], `
const a = $('Answer').first().json;
const s = $('Send answer (guarded)').first().json;
const d = $('Decide branch').first().json;
return [{ json: { records: [{ id: a.reply_record_id, fields: { reply_approved: true, handled_at: new Date().toISOString(), handled_by: d.mode === 'reprocess' ? 'Slack + auto' : 'auto (confidence ' + d.cls.confidence + ')' } }], typecast: true,
  slack: { ref: a.reply_record_id, text: ':robot_face: Auto-answered *' + (d.lead.company_name || '') + '* (Interested, confidence ' + d.cls.confidence + ') with the Calendly link:\\n>' + a.body.replace(/\\n/g, '\\n>') + '\\n_Sent as ' + s.subject + ' to ' + s.sent_to + '_' } } }];`);
  w.atWrite('Save answered', 'Replies', 'PATCH');
  w.code('Info message', [], `return [{ json: $('Mark answered').first().json.slack }];`);
  w.execWorkflow('Post info', '15_slack_notify');
  w.kick('CRM sync', 'crm-sync', "{ lead_record_id: $('Decide branch').first().json.lead.id }");
  w.at(21, -1);
  w.code('Approval message', ['slackMessages'], `
const cfg = $('Config').first().json.cfg;
const d = $('Decide branch').first().json;
const a = $('Answer').first().json;
const m = M.slackMessages.interestedApproval({ kind: d.route.branch === 'Question' ? 'Question' : 'Interested', company: d.lead.company_name, fromEmail: d.reply.from_email, confidence: d.cls.confidence, replyBody: d.reply.body_clean || d.reply.body,
  suggestedReply: a.body, replyRecordId: a.reply_record_id, editUrl: cfg.interfaceUrl ? cfg.interfaceUrl : undefined });
return [{ json: { ref: a.reply_record_id, text: m.text, blocks: m.blocks } }];`);
  w.execWorkflow('Ask in Slack', '15_slack_notify');
  w.code('Save Slack ts', [], `
const p = $('Ask in Slack').first().json;
return [{ json: { records: [{ id: p.ref, fields: { slack_ts: p.ts, slack_channel: p.channel } }], typecast: true } }];`);
  w.atWrite('Save approval ts', 'Replies', 'PATCH');
  w.kick('CRM sync (pending answer)', 'crm-sync', "{ lead_record_id: $('Decide branch').first().json.lead.id }");

  // Later
  w.at(16, 1);
  w.code('Follow-up task', [], `
const d = $('Decide branch').first().json;
return [{ json: { records: [{ fields: { key: 'Follow up later · ' + d.lead.company_name, lead: [d.lead.id], lead_record_id: d.lead.id, type: 'Follow up later',
  due_at: d.route.followUpAt, summary: d.cls.summary, status: 'Open' } }], typecast: true,
  slack: { ref: d.lead.id, text: ':hourglass: *' + d.lead.company_name + '* says later. Follow-up task on ' + String(d.route.followUpAt).slice(0, 10) + '.' } } }];`);
  w.atWrite('Create task', 'Tasks', 'POST');
  w.code('Later note', [], `return [{ json: $('Follow-up task').first().json.slack }];`);
  w.execWorkflow('Post later note', '15_slack_notify');

  // Unsure
  w.at(16, 2);
  w.code('Sort message', ['slackMessages'], `
const d = $('Decide branch').first().json;
const saved = $('Save reply').first().json.records[0];
const m = M.slackMessages.sortReply({ company: d.lead.company_name, fromEmail: d.reply.from_email, category: d.cls.category, confidence: d.cls.confidence, replyBody: d.reply.body_clean || d.reply.body, replyRecordId: saved.id });
return [{ json: { ref: saved.id, text: m.text, blocks: m.blocks } }];`);
  w.execWorkflow('Ask to sort', '15_slack_notify');
  w.code('Save sort ts', [], `
const p = $('Ask to sort').first().json;
return [{ json: { records: [{ id: p.ref, fields: { slack_ts: p.ts, slack_channel: p.channel } }], typecast: true } }];`);
  w.atWrite('Save sort ts in Airtable', 'Replies', 'PATCH');

  // Referral ("wenden Sie sich an Frau Klein, klein@firma.de"): write to the named colleague, or a task if not possible
  w.at(16, 6);
  w.atList('Referral clients', 'Clients', null);
  w.atList('Referral campaign', 'Campaigns', "\"RECORD_ID()='\" + String($('Decide branch').first().json.lead.campaign_record_id || '__none__') + \"'\"");
  w.atList('Referral known', 'Leads', "\"LOWER({email})='\" + String($('Decide branch').first().json.cls.referral_email || '__none__').toLowerCase().replace(/'/g, '') + \"'\"");
  w.atList('Referral blocklist', 'Blocklist', null);
  w.code('Referral plan', ['replies', 'guard', 'parseImpressum', 'airtable', 'validateEmails'], `
const d = $('Decide branch').first().json;
const camp = M.airtable.fromItems($('Referral campaign').all())[0] || {};
const clients = M.airtable.fromItems($('Referral clients').all());
const client = clients.find((k) => k.id === camp.client_record_id) || clients.find((k) => k.is_default) || clients[0] || {};
const plan = M.replies.referralPlan({ cls: d.cls, lead: d.lead, replyBody: d.reply.body, relatedDomain: M.parseImpressum.relatedDomain,
  isBlocked: M.guard.isBlocked, blocklist: M.airtable.fromItems($('Referral blocklist').all()), existingEmails: M.airtable.fromItems($('Referral known').all()).map((l) => l.email) });
const frame = { frame: true, contactName: plan.name, senderName: client.sender_name || '', signature: M.validateEmails.buildSignature(client) };
return [{ json: { plan, client, frame, footer: M.validateEmails.buildFooter(client),
  request: { ref: 'referral', prompt_id: 'referral_intro', max_tokens: 400, validate_opts: frame, vars: {
    sender_name: client.sender_name || '', sender_title: client.sender_title || '', sender_company: client.sender_company || client.name || '',
    offer: M.validateEmails.offerText(client, camp.industry), writing_notes: String(client.writing_notes || '').trim() || '(keine)', referrer_name: d.lead.contact_name || d.reply.from_email, company_name: d.lead.company_name || '',
    referral_name: plan.name || 'Ansprechpartner', company_summary: d.lead.company_summary || '' } } } }];`);
  w.ifTrue('Referral: contact?', "$('Referral plan').first().json.plan.action === 'contact'");
  w.code('Referral request', [], `return [{ json: $('Referral plan').first().json.request }];`);
  w.execWorkflow('AI: referral email', '14_ai_call');
  w.code('Referral email', ['validateEmails'], `
const p = $('Referral plan').first().json;
const d = $('Decide branch').first().json;
const a = $('AI: referral email').all().map((i) => i.json).find((x) => x && x.ref === 'referral');
const body = a && a.ok ? a.data.body : M.validateEmails.ensureFrame((d.lead.contact_name || 'Ihr Kollege') + ' von ' + (d.lead.company_name || 'Ihrer Firma') +
  ' hat mich an Sie verwiesen. ' + M.validateEmails.offerText(p.client) + '\\n\\nPasst Ihnen ein kurzes Telefonat von 15 Minuten?', p.frame);
const subject = a && a.ok ? a.data.subject : 'Empfehlung von ' + (d.lead.contact_name || d.lead.company_name || 'Ihrem Kollegen');
return [{ json: { ref: d.lead.id, to: p.plan.email, subject, body: M.validateEmails.appendFooter(body, p.footer), purpose: 'referral', ai_ok: !!(a && a.ok) } }];`);
  w.execWorkflow('Send referral (guarded)', '13_send_email', { alwaysOutputData: false });
  w.code('Referred lead', [], `
const d = $('Decide branch').first().json;
const p = $('Referral plan').first().json.plan;
const l = d.lead;
const now = new Date().toISOString();
return [{ json: { records: [{ fields: {
  company_name: l.company_name, campaign: l.campaign_record_id ? [l.campaign_record_id] : undefined, campaign_record_id: l.campaign_record_id, domain: l.domain, website: l.website,
  phone: l.phone, address: l.address, city: l.city, company_summary: l.company_summary, contact_name: p.name || null, email: p.email, contact_source: 'Empfehlung',
  trigger: 'Empfehlung von ' + (l.contact_name || 'einem Kollegen'), score: l.score, status: 'Contacted', sequence_step: 1, first_sent_at: now, sequence_finished: true,
  source: 'Referral from ' + (l.email || l.id), sourced_at: now, lead_type: 'Outbound',
} }], typecast: true } }];`);
  w.atWrite('Create referred lead', 'Leads', 'POST');
  w.code('Referral email record', [], `
const s = $('Send referral (guarded)').first().json;
const e = $('Referral email').first().json;
const lead = $('Create referred lead').first().json.records[0];
return [{ json: { records: [{ fields: { key: (lead.fields.company_name || '') + ' · referral', lead: [lead.id], lead_record_id: lead.id, campaign_record_id: lead.fields.campaign_record_id,
  step: 1, subject: e.subject, body: e.body, approved: true, status: 'Sent', sent_at: s.sent_at, gmail_message_id: s.id, thread_id: s.threadId, subject_sent: s.subject,
  sent_to: s.sent_to, original_to: s.original_to } }], typecast: true } }];`);
  w.atWrite('Save referral email', 'Emails', 'POST');
  w.code('Referral note', [], `
const d = $('Decide branch').first().json;
const p = $('Referral plan').first().json.plan;
return [{ json: { ref: d.lead.id, text: ':arrow_right_hook: *' + d.lead.company_name + '*: ' + (d.lead.contact_name || 'the contact') + ' referred us to *' + (p.name || p.email) +
  '* (' + p.email + '). Intro email sent automatically in the same tone; their reply is tracked like any other lead.' } }];`);
  w.execWorkflow('Post referral note', '15_slack_notify');
  w.at(19, 7);
  w.code('Referral task', [], `
const d = $('Decide branch').first().json;
const p = $('Referral plan').first().json.plan;
const due = new Date(Date.now() + 24 * 3600000).toISOString();
return [{ json: { records: [{ fields: { key: 'Referral · ' + d.lead.company_name, lead: d.lead.id ? [d.lead.id] : undefined, lead_record_id: d.lead.id, type: 'Follow up referral',
  due_at: due, summary: 'Verweis auf ' + (p.name || 'eine andere Person') + (p.email ? ' (' + p.email + ')' : '') + ': ' + p.reason + '. ' + d.cls.summary, status: 'Open' } }], typecast: true,
  slack: { ref: d.lead.id, text: ':arrow_right_hook: *' + d.lead.company_name + '* referred us to *' + (p.name || 'someone else') + '*, but no automatic contact (' + p.reason + '). Task created.' } } }];`);
  w.atWrite('Create referral task', 'Tasks', 'POST');
  w.code('Referral task note', [], `return [{ json: $('Referral task').first().json.slack }];`);
  w.execWorkflow('Post referral task', '15_slack_notify');

  // Not interested / Unsubscribe after earlier interest: cancel booked meetings, close the HubSpot deal
  w.at(16, 3);
  w.atList('Booked meetings', 'Meetings', "\"AND({lead_record_id}='\" + String($('Decide branch').first().json.lead.id || '__none__') + \"',OR({status}='Booked',{status}='Reminded'))\"");
  w.code('Withdrawal', ['replies', 'airtable'], `
const d = $('Decide branch').first().json;
const plan = M.replies.withdrawalPlan({ branch: d.route.branch, lead: d.lead, fromEmail: d.reply.from_email, meetings: M.airtable.fromItems($('Booked meetings').all()) });
return [{ json: Object.assign(plan, { cancel: { records: plan.cancelMeetingIds.map((id) => ({ id, fields: { status: 'Cancelled' } })), typecast: true } }) }];`);
  w.ifTrue('Meetings to cancel?', "$('Withdrawal').first().json.cancelMeetingIds.length > 0");
  w.atWrite('Cancel meetings', 'Meetings', 'PATCH', { body: "$('Withdrawal').first().json.cancel" });
  // Airtable is already Cancelled (so 07d's later poll of the cancelled event is a no-op); now cancel in Calendly itself,
  // which also sends the invitee Calendly's cancellation email. A failure never stops the run: Slack then asks for a manual cancel.
  w.code('Calendly cancel requests', ['calendly'], `
return $('Withdrawal').first().json.meetings.map((m) => ({ json: M.calendly.cancellationRequest(m, 'Der Interessent hat per E-Mail abgesagt.') }));`);
  w.http('Cancel in Calendly', {
    method: 'POST', url: `={{ ${CFG('calendlyApiUrl')} }}{{ $json.path }}`, headers: [['Authorization', '=Bearer {{ $env.CALENDLY_TOKEN }}']],
    body: '$json.body', fullResponse: true, neverError: true, continueOnFail: true, batch: { size: 1, interval: 300 },
    notes: 'Calendly API: POST /scheduled_events/{uuid}/cancellation (201 = cancelled)',
  });

  // Not interested / Unsubscribe / Out of office / Bounce / Unmatched: short note
  w.at(19, 3);
  w.code('Status note', ['calendly', 'replies'], `
const d = $('Decide branch').first().json;
const wd = $('Withdrawal').isExecuted ? $('Withdrawal').first().json : { withdrew: false, crmSync: false };
const name = d.lead.company_name || d.reply.from_email;
if (wd.withdrew) {
  const reqs = $('Calendly cancel requests').isExecuted ? $('Calendly cancel requests').all().map((i) => i.json) : [];
  const res = $('Cancel in Calendly').isExecuted ? $('Cancel in Calendly').all().map((i) => i.json) : [];
  const results = reqs.length ? reqs.map((r, i) => !r.uuid ? { ok: false, problem: 'no Calendly event id stored' }
    : { ok: M.calendly.cancellationOk(res[i]), problem: M.calendly.cancellationProblem(res[i]) }) : null;
  return [{ json: { ref: d.lead.id, text: M.replies.withdrawalText(wd, results), crm_sync: wd.crmSync, calendly: results } }];
}
const t = { 'Not interested': ':no_entry_sign: *' + name + '*: not interested, lead closed.',
  Unsubscribe: ':lock: *' + name + '* unsubscribed (' + d.cls.by + '). Added to the Blocklist, never contacted again.',
  'Out of office': ':palm_tree: *' + name + '* is out of office until ' + (d.cls.return_date || 'unknown') + '. Sequence paused, resumes ' + String(d.route.resumeAt).slice(0, 16) + '.',
  Bounce: ':x: Bounce for *' + name + '* (' + (d.lead.email || '') + '). Lead Bounced, address blocked.',
  Unmatched: ':grey_question: Reply from ' + d.reply.from_email + ' could not be matched to a lead (subject: ' + d.reply.subject + ').' }[d.route.branch];
return [{ json: { ref: d.lead.id || 'unmatched', text: t } }];`);
  w.execWorkflow('Post status note', '15_slack_notify');
  w.ifTrue('Close HubSpot deal?', "!!$('Status note').first().json.crm_sync");
  w.kick('CRM sync (closed)', 'crm-sync', "{ lead_record_id: $('Decide branch').first().json.lead.id }");

  w.chain('Reply webhook', 'Config', 'Normalise', 'Re-sorted in Slack?');
  w.connect('Re-sorted in Slack?', 'Load reply', 0);
  w.connect('Re-sorted in Slack?', 'Emails in thread', 1);
  w.chain('Load reply', 'Reply from record', 'Emails in thread');
  w.chain('Emails in thread', 'Lead lookup', 'Candidate leads', 'Match + rules', 'Classifier request', 'AI: classify reply', 'Decide branch', 'Save reply', 'Lead matched?');
  w.connect('Lead matched?', 'Stop sequence + status', 0);
  w.connect('Lead matched?', 'Branch', 1);
  w.connect('Stop sequence + status', 'Blocklist?');
  w.connect('Blocklist?', 'Add to Blocklist', 0);
  w.connect('Blocklist?', 'Branch', 1);
  w.connect('Add to Blocklist', 'Branch');
  w.connect('Branch', 'Answer clients', 0);
  w.connect('Branch', 'Answer clients', 8); // Question: same drafted answer, always approved by a person in Slack
  w.connect('Branch', 'Referral clients', 9);
  w.chain('Referral clients', 'Referral campaign', 'Referral known', 'Referral blocklist', 'Referral plan', 'Referral: contact?');
  w.connect('Referral: contact?', 'Referral request', 0);
  w.connect('Referral: contact?', 'Referral task', 1);
  w.chain('Referral request', 'AI: referral email', 'Referral email', 'Send referral (guarded)', 'Referred lead', 'Create referred lead', 'Referral email record', 'Save referral email', 'Referral note', 'Post referral note');
  w.chain('Referral task', 'Create referral task', 'Referral task note', 'Post referral task');
  w.chain('Answer clients', 'Answer campaign', 'Answer request');
  w.connect('Branch', 'Follow-up task', 1);
  w.connect('Branch', 'Sort message', 2);
  [3, 4].forEach((i) => w.connect('Branch', 'Booked meetings', i));
  [5, 6, 7].forEach((i) => w.connect('Branch', 'Status note', i));
  w.chain('Booked meetings', 'Withdrawal', 'Meetings to cancel?');
  w.connect('Meetings to cancel?', 'Cancel meetings', 0);
  w.connect('Meetings to cancel?', 'Status note', 1);
  w.chain('Cancel meetings', 'Calendly cancel requests', 'Cancel in Calendly', 'Status note');
  w.chain('Answer request', 'AI: answer', 'Answer', 'Save suggested reply', 'Confidence ≥ 0.85?');
  w.connect('Confidence ≥ 0.85?', 'Answer email', 0);
  w.connect('Confidence ≥ 0.85?', 'Approval message', 1);
  w.chain('Answer email', 'Send answer (guarded)', 'Mark answered', 'Save answered', 'Info message', 'Post info', 'CRM sync');
  w.chain('Approval message', 'Ask in Slack', 'Save Slack ts', 'Save approval ts', 'CRM sync (pending answer)');
  w.chain('Follow-up task', 'Create task', 'Later note', 'Post later note');
  w.chain('Sort message', 'Ask to sort', 'Save sort ts', 'Save sort ts in Airtable');
  w.chain('Status note', 'Post status note', 'Close HubSpot deal?');
  w.connect('Close HubSpot deal?', 'CRM sync (closed)', 0);
  return w;
}

function gmailInbox() {
  const w = new Workflow('07a_gmail_inbox', 'Nexsale 07a – Gmail inbox (reply trigger)', { description: 'Polls the sender inbox every minute and hands each new mail to 07_replies. Needs the Gmail OAuth credential.' });
  w.add('New mail in sender inbox', 'n8n-nodes-base.gmailTrigger', 1.2, {
    pollTimes: { item: [{ mode: 'everyMinute' }] }, simple: false, filters: { q: 'in:inbox -from:me newer_than:2d' }, options: {},
  }, { credentials: { gmailOAuth2: { id: 'REPLACE_WITH_CREDENTIAL_ID', name: 'Gmail sender' } } });
  w.config();
  w.http('Hand to 07_replies', {
    method: 'POST', url: `={{ ${CFG('n8nInternalUrl')} }}/webhook/reply-ingest`,
    body: "{ id: $('New mail in sender inbox').item.json.id, threadId: $('New mail in sender inbox').item.json.threadId, from: $('New mail in sender inbox').item.json.from, to: $('New mail in sender inbox').item.json.to, subject: $('New mail in sender inbox').item.json.subject, text: $('New mail in sender inbox').item.json.text, date: $('New mail in sender inbox').item.json.date, headers: $('New mail in sender inbox').item.json.headers }",
    batch: { size: 1, interval: 500 },
  });
  w.chain('New mail in sender inbox', 'Config', 'Hand to 07_replies');
  return w;
}

function calendly() {
  const w = new Workflow('07b_calendly', 'Nexsale 07b – Calendly bookings', { description: 'invitee.created → Meeting booked; invitee.canceled → Cancelled. The same webhook twice gives one meeting.' });
  w.webhook('Calendly webhook', 'calendly', { rawBody: true });
  w.config();
  w.code('Verify + parse', ['calendly'], `
const crypto = require('crypto');
const item = $('Calendly webhook').first();
let raw = '';
try { raw = (await this.helpers.getBinaryDataBuffer(0, 'data')).toString('utf8'); } catch (e) { raw = ''; }
const v = M.calendly.verifyCalendlySignature({ signingKey: $env.CALENDLY_WEBHOOK_SIGNING_KEY, header: item.json.headers['calendly-webhook-signature'], rawBody: raw, crypto });
if (!v.ok) throw new Error('Calendly signature rejected: ' + v.reason);
const p = M.calendly.parseCalendly(item.json.body);
if (!p.valid) return [];
return [{ json: p }];`);
  w.atList('Existing meeting', 'Meetings', "\"{calendly_event_id}='\" + $('Verify + parse').first().json.calendly_event_id + \"'\"");
  w.atList('Lead', 'Leads', "'OR(' + ($('Verify + parse').first().json.utm_content ? \"RECORD_ID()='\" + $('Verify + parse').first().json.utm_content + \"',\" : '') + \"LOWER({email})='\" + $('Verify + parse').first().json.email + \"')\"");
  w.code('Decide', ['calendly', 'airtable', 'reminders'], `
const p = $('Verify + parse').first().json;
const meetings = M.airtable.fromItems($('Existing meeting').all());
const leads = M.airtable.fromItems($('Lead').all());
const lead = leads.find((l) => l.id === p.utm_content) || leads.find((l) => String(l.email).toLowerCase() === p.email) || null;
const a = M.calendly.meetingAction(p, meetings);
if (a.action === 'create' && !lead) a.action = 'unmatched';
return [{ json: { action: a.action, reason: a.reason || '', p, lead, meeting: a.meeting || null, when: p.start_time ? M.reminders.formatBerlin(p.start_time) : '' } }];`);
  w.switchOn('Action', '$json.action', ['create', 'cancel', 'skip', 'unmatched']);
  w.at(7, -1);
  w.code('Meeting record', [], `
const d = $('Decide').first().json;
return [{ json: { records: [{ fields: { key: d.lead.company_name + ' · ' + d.p.start_time, lead: [d.lead.id], lead_record_id: d.lead.id, calendly_event_id: d.p.calendly_event_id,
  start_time: d.p.start_time, invitee_email: d.p.email, status: 'Booked' } }], typecast: true } }];`);
  w.atWrite('Create meeting', 'Meetings', 'POST');
  w.atWrite('Lead: Meeting booked', 'Leads', 'PATCH', { body: "{ records: [{ id: $('Decide').first().json.lead.id, fields: { status: 'Meeting booked' } }], typecast: true }" });
  // meeting brief for the client: who, what, why now, what to ask (AI from our data; factual fallback without AI)
  w.atList('Brief replies', 'Replies', "\"{lead_record_id}='\" + $('Decide').first().json.lead.id + \"'\"");
  w.atList('Brief client', 'Clients', null);
  w.atList('Brief campaign', 'Campaigns', "\"RECORD_ID()='\" + String($('Decide').first().json.lead.campaign_record_id || '__none__') + \"'\"");
  w.code('Brief request', ['brief', 'airtable'], `
const d = $('Decide').first().json;
const camp = M.airtable.fromItems($('Brief campaign').all())[0] || {};
const clients = M.airtable.fromItems($('Brief client').all());
const client = clients.find((k) => k.id === camp.client_record_id) || clients.find((k) => k.is_default) || clients[0] || {};
return [{ json: { ref: 'brief', prompt_id: 'meeting_brief', max_tokens: 600, vars: M.brief.briefVars(d.lead, M.airtable.fromItems($('Brief replies').all()), d.p.questions, d.when, client) } }];`);
  w.execWorkflow('AI: meeting brief', '14_ai_call');
  w.code('Brief', ['brief'], `
const d = $('Decide').first().json;
const a = $('AI: meeting brief').all().map((i) => i.json).find((x) => x && x.ref === 'brief');
const text = M.brief.formatBrief(a && a.ok ? a.data : null, d.lead, d.when, d.p.questions);
return [{ json: { text, ai_ok: !!(a && a.ok), save: { records: [{ id: d.lead.id, fields: { meeting_brief: text.replace(/\\*/g, '') } }], typecast: true } } }];`);
  w.atWrite('Save brief', 'Leads', 'PATCH', { body: "$('Brief').first().json.save" });
  w.code('Booked message', [], `
const d = $('Decide').first().json;
return [{ json: { ref: d.lead.id, text: ':calendar: Meeting booked with *' + d.lead.company_name + '* (' + (d.lead.contact_name || d.p.name) + ') on ' + d.when + '.\\n\\n' + $('Brief').first().json.text } }];`);
  w.execWorkflow('Post booked', '15_slack_notify');
  w.kick('CRM sync', 'crm-sync', "{ lead_record_id: $('Decide').first().json.lead.id }");
  w.at(7, 1);
  w.atWrite('Meeting: Cancelled', 'Meetings', 'PATCH', { body: "{ records: [{ id: $('Decide').first().json.meeting.id, fields: { status: 'Cancelled' } }], typecast: true }" });
  w.atWrite('Lead: back to Interested', 'Leads', 'PATCH', { body: "{ records: [{ id: $('Decide').first().json.meeting.lead_record_id, fields: { status: 'Interested' } }], typecast: true }" });
  w.code('Cancelled message', [], `
const d = $('Decide').first().json;
return [{ json: { ref: d.meeting.id, text: ':x: Meeting cancelled by ' + d.p.email + (d.p.cancel_reason ? ' (' + d.p.cancel_reason + ')' : '') + '.' } }];`);
  w.execWorkflow('Post cancelled', '15_slack_notify');
  w.at(7, 3);
  w.code('Unmatched booking', [], `
const d = $('Decide').first().json;
return [{ json: { ref: 'calendly', text: ':grey_question: Calendly booking by ' + d.p.email + ' on ' + d.when + ' could not be matched to a lead.' } }];`);
  w.execWorkflow('Post unmatched', '15_slack_notify');
  w.chain('Calendly webhook', 'Verify + parse', 'Config', 'Existing meeting', 'Lead', 'Decide', 'Action');
  w.connect('Action', 'Meeting record', 0);
  w.connect('Action', 'Meeting: Cancelled', 1);
  w.connect('Action', 'Unmatched booking', 3);
  w.chain('Meeting record', 'Create meeting', 'Lead: Meeting booked', 'Brief replies', 'Brief client', 'Brief campaign', 'Brief request', 'AI: meeting brief', 'Brief', 'Save brief', 'Booked message', 'Post booked', 'CRM sync');
  w.chain('Meeting: Cancelled', 'Lead: back to Interested', 'Cancelled message', 'Post cancelled');
  w.connect('Unmatched booking', 'Post unmatched');
  return w;
}

function reminders() {
  const w = new Workflow('07c_reminders', 'Nexsale 07c – Meeting reminders', { description: 'Hourly: reminder email 24 h before; 15 min after the start Slack asks "Held or no-show?".' });
  w.schedule('Every hour', { field: 'hours', hoursInterval: 1 });
  w.at(0, 1);
  w.webhook('Run now', 'reminders-run');
  w.at(1, 0);
  w.config();
  w.atList('Open meetings', 'Meetings', "\"OR({status}='Booked',{status}='Reminded')\"");
  w.code('Due', ['reminders', 'airtable'], `
const m = M.airtable.fromItems($('Open meetings').all());
const r = M.reminders.dueReminders(m, new Date());
if (!r.reminders.length && !r.heldChecks.length) return [];
const ids = Array.from(new Set(r.reminders.concat(r.heldChecks).map((x) => x.lead_record_id)));
return [{ json: { reminders: r.reminders, heldChecks: r.heldChecks, formula: 'OR(' + ids.map((id) => "RECORD_ID()='" + id + "'").join(',') + ')' } }];`);
  w.atList('Meeting leads', 'Leads', '$json.formula');
  w.atList('Clients', 'Clients', null);
  w.code('Reminder emails', ['reminders', 'airtable', 'validateEmails'], `
const d = $('Due').first().json;
const leads = M.airtable.fromItems($('Meeting leads').all());
const client = M.airtable.fromItems($('Clients').all())[0];
return d.reminders.map((m) => {
  const lead = leads.find((l) => l.id === m.lead_record_id) || {};
  return { json: Object.assign({ ref: m.id }, M.reminders.reminderEmail(m, lead, client, M.reminders.formatBerlin(m.start_time), M.validateEmails)) };
}).filter((i) => i.json.to);`);
  w.execWorkflow('Send reminders (guarded)', '13_send_email', { alwaysOutputData: false });
  w.code('Mark reminded', ['airtable'], `
return M.airtable.updateBatches($('Send reminders (guarded)').all().filter((i) => i.json.ok).map((i) => ({ id: i.json.ref, fields: { status: 'Reminded', reminder_sent_at: new Date().toISOString() } }))).map((b) => ({ json: b }));`);
  w.atWrite('Save reminded', 'Meetings', 'PATCH');
  w.at(5, 2);
  w.code('Held checks', ['slackMessages', 'reminders', 'airtable'], `
const d = $('Due').first().json;
const leads = M.airtable.fromItems($('Meeting leads').all());
return d.heldChecks.map((m) => {
  const lead = leads.find((l) => l.id === m.lead_record_id) || {};
  const msg = M.slackMessages.heldOrNoShow({ company: lead.company_name || m.invitee_email, start: M.reminders.formatBerlin(m.start_time), meetingRecordId: m.id });
  return { json: { ref: m.id, text: msg.text, blocks: msg.blocks } };
});`);
  w.execWorkflow('Ask held or no-show', '15_slack_notify', { alwaysOutputData: false });
  w.code('Mark asked', ['airtable'], `
return M.airtable.updateBatches($('Ask held or no-show').all().filter((i) => i.json.ref).map((i) => ({ id: i.json.ref, fields: { held_check_sent_at: new Date().toISOString(), slack_ts: i.json.ts, slack_channel: i.json.channel } }))).map((b) => ({ json: b }));`);
  w.atWrite('Save asked', 'Meetings', 'PATCH');
  w.connect('Every hour', 'Config');
  w.connect('Run now', 'Config');
  w.chain('Config', 'Open meetings', 'Due', 'Meeting leads', 'Clients', 'Reminder emails', 'Send reminders (guarded)', 'Mark reminded', 'Save reminded');
  w.connect('Clients', 'Held checks');
  w.chain('Held checks', 'Ask held or no-show', 'Mark asked', 'Save asked');
  return w;
}

function calendlyPoll() {
  const w = new Workflow('07d_calendly_poll', 'Nexsale 07d – Calendly poll (free plan)', { description: 'Calendly free plan has no webhooks: every 3 minutes read new/cancelled bookings and hand them to 07b_calendly.' });
  w.schedule('Every 3 minutes', { field: 'minutes', minutesInterval: 3 });
  w.at(0, 1);
  w.webhook('Poll now', 'calendly-poll');
  w.at(1, 0);
  w.config();
  const CAL_AUTH = [['Authorization', '=Bearer {{ $env.CALENDLY_TOKEN }}']];
  w.http('Calendly user', { method: 'GET', url: `={{ ${CFG('calendlyApiUrl')} }}/users/me`, headers: CAL_AUTH, executeOnce: true });
  w.http('Upcoming events', {
    method: 'GET', url: `={{ ${CFG('calendlyApiUrl')} }}/scheduled_events`, headers: CAL_AUTH, executeOnce: true,
    query: [['user', '={{ $json.resource.uri }}'], ['min_start_time', '={{ new Date(Date.now() - 2 * 3600000).toISOString() }}'], ['count', '100'], ['sort', 'start_time:asc']],
    notes: 'Active and cancelled events from 2 h ago onwards',
  });
  w.code('Events', [], `
const list = ($json.collection || []);
if ($json.error || $json.message && !$json.collection) throw new Error('Calendly API error: ' + ($json.message || JSON.stringify($json.error)));
return list.map((e) => ({ json: { event: e, uuid: String(e.uri).split('/').pop() } }));`);
  w.http('Invitees', { method: 'GET', url: `={{ ${CFG('calendlyApiUrl')} }}/scheduled_events/{{ $json.uuid }}/invitees`, headers: CAL_AUTH, query: [['count', '100']], batch: { size: 3, interval: 400 } });
  w.code('Changed bookings', ['calendly'], `
const evs = $('Events').all().map((i) => i.json.event);
const inv = {};
$input.all().forEach((it, i) => { inv[evs[i].uri] = it.json.collection || []; });
return M.calendly.pollToPayloads(evs, inv, new Date(), 30).map((p) => ({ json: p }));`, { notes: 'Only invitees created/cancelled in the last 30 min; 07b ignores duplicates' });
  w.http('Hand to 07b_calendly', { method: 'POST', url: `={{ ${CFG('n8nInternalUrl')} }}/webhook/calendly`, body: '$json', batch: { size: 1, interval: 500 } });
  w.connect('Every 3 minutes', 'Config');
  w.connect('Poll now', 'Config');
  w.chain('Config', 'Calendly user', 'Upcoming events', 'Events', 'Invitees', 'Changed bookings', 'Hand to 07b_calendly');
  return w;
}

module.exports = [replies, gmailInbox, calendly, reminders, calendlyPoll];
