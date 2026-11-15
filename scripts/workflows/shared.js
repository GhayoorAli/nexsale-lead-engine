/** 00 error handler + shared sub-workflows 13 (send email), 14 (AI call), 15 (Slack notify). */
const { Workflow, CFG, loadPrompts } = require('../n8n_builder');

function errorHandler() {
  const w = new Workflow('00_error_handler', 'Nexsale 00 – Error handler', { errorWorkflow: false, description: 'Error Workflow of every other workflow: writes Logs and alerts Slack.' });
  w.errorTrigger('Error Trigger');
  w.config();
  w.code('Format error', [], `
const e = $('Error Trigger').first().json;
const exec = e.execution || {};
const wf = e.workflow || {};
const err = exec.error || e.trigger && e.trigger.error || {};
const node = exec.lastNodeExecuted || (err.node && err.node.name) || 'unknown node';
const message = String(err.message || 'unknown error').slice(0, 1500);
const text = ':rotating_light: *n8n error* in *' + (wf.name || 'unknown workflow') + '*\\nNode: ' + node + '\\nError: ' + message + (exec.url ? '\\n<' + exec.url + '|Open execution>' : '');
return [{ json: {
  slack: { text },
  log: { records: [{ fields: { key: (wf.name || 'workflow') + ' · ' + new Date().toISOString(), workflow: wf.name || '', level: 'error', node, message, execution_url: exec.url || '', created_at: new Date().toISOString() } }], typecast: true },
} }];`);
  w.http('Write Logs', {
    method: 'POST', url: `={{ ${CFG('airtableUrl')} }}/Logs`, headers: [['Authorization', '=Bearer {{ $env.AIRTABLE_PAT }}']],
    body: '$json.log', continueOnFail: true, notes: 'Airtable: Logs (continues if Airtable itself is the problem)',
  });
  w.http('Alert Slack', {
    method: 'POST', url: '={{ $env.SLACK_WEBHOOK_URL }}', body: "$('Format error').first().json.slack", text: true,
    notes: 'Incoming webhook, independent of the bot token, so expired bot credentials are still reported',
  });
  w.chain('Error Trigger', 'Config', 'Format error', 'Write Logs', 'Alert Slack');
  return w;
}

function sendEmail() {
  const w = new Workflow('13_send_email', 'Nexsale 13 – Send email (guarded)', { description: 'The ONLY place that sends email. Blocklist + allowlist guard right before the send node. DEMO_MODE: prospect mails → test inbox, internal notifications → sender, header X-Nexsale-Test.' });
  w.subTrigger('When called');
  w.config();
  w.atList('Load Blocklist', 'Blocklist', null, { notes: 'Blocklist is checked before every send' });
  w.code('Guard: allowlist + blocklist', ['guard', 'mime', 'airtable'], `
const cfg = $('Config').first().json.cfg;
const blocklist = M.airtable.fromItems($('Load Blocklist').all()); // throws if the Blocklist could not be read
// placeholder items from callers without work ({} or {skip:true}) are dropped here
const msgs = $('When called').all().map((i) => i.json).filter((m) => m && m.ref && !m.skip);
const out = [];
for (const m of msgs) {
  const originals = M.guard.splitAddresses(m.to);
  const hit = originals.find((a) => M.guard.isBlocked(a, blocklist));
  if (hit) throw new M.guard.GuardError('Guard: recipient ' + hit + ' is on the Blocklist (ref ' + m.ref + ')');
  const g = M.guard.guardEmail(m, cfg); // throws -> run stops -> error handler alerts Slack
  const raw = M.mime.buildRawEmail({ from: cfg.senderEmail, fromName: m.fromName, to: g.to, subject: g.subject, body: m.body, html: m.html, inReplyTo: m.inReplyTo,
    extraHeaders: g.testMarker ? { 'X-Nexsale-Test': 'true' } : {}, listUnsubscribe: cfg.senderEmail ? '<mailto:' + cfg.senderEmail + '?subject=STOP>' : '' });
  const body = { raw };
  if (m.threadId) body.threadId = m.threadId;
  out.push({ json: { ref: m.ref, gmail: body, sent_to: g.to, original_to: g.original_to || g.to, subject: g.subject, purpose: m.purpose || 'outreach' } });
}
return out;`, { notes: 'SAFETY GUARD: stops the run if any recipient is not on TEST_RECIPIENT_ALLOWLIST; DEMO_MODE rewrites To (internal → sender, all others → test inbox) and marks the mail with X-Nexsale-Test.' });
  w.ifTrue('Mock?', `${CFG('mock')}`);
  w.at(5, 1);
  w.http('Send via mock Gmail', { method: 'POST', url: `={{ ${CFG('gmailUrl')} }}/users/me/messages/send`, body: '$json.gmail', notes: 'MOCK_EXTERNAL=true: test inbox in tests/mock_server' });
  w.at(5, -1);
  w.http('Send via Gmail', { method: 'POST', url: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send', body: '$json.gmail', credential: 'gmailOAuth2', credentialName: 'Gmail sender', notes: 'Real Gmail API (OAuth credential set in the n8n UI)' });
  w.at(6, 0);
  w.code('Result', [], `
const guarded = $('Guard: allowlist + blocklist').all();
return $input.all().map((it, i) => ({ json: {
  ref: guarded[i].json.ref, ok: !!it.json.id, id: it.json.id, threadId: it.json.threadId,
  sent_to: guarded[i].json.sent_to, original_to: guarded[i].json.original_to, subject: guarded[i].json.subject, sent_at: new Date().toISOString(),
} }));`);
  w.chain('When called', 'Config', 'Load Blocklist', 'Guard: allowlist + blocklist', 'Mock?');
  w.connect('Mock?', 'Send via mock Gmail', 0);
  w.connect('Mock?', 'Send via Gmail', 1);
  w.connect('Send via mock Gmail', 'Result');
  w.connect('Send via Gmail', 'Result');
  return w;
}

function aiCall() {
  const prompts = loadPrompts();
  const w = new Workflow('14_ai_call', 'Nexsale 14 – AI call (JSON, validated, 1 retry)', { description: 'Every AI call: prompt from prompts/*.md, JSON only, validated, retried once on invalid output.' });
  w.subTrigger('When called');
  w.config();
  w.code('Build request', ['aiRequest'], `
const PROMPTS = ${JSON.stringify(prompts)};
const cfg = $('Config').first().json.cfg;
const items = $('When called').all().map((i) => i.json).filter((j) => j && j.ref && j.prompt_id);
return items.map((j) => {
  const tpl = M.aiRequest.splitPrompt(PROMPTS[j.prompt_id] || '');
  const vars = Object.assign({ retry_note: '' }, j.vars || {});
  const system = M.aiRequest.fillTemplate(tpl.system, vars);
  const user = M.aiRequest.fillTemplate(tpl.user, vars);
  return { json: { ref: j.ref, prompt_id: j.prompt_id, validate_opts: j.validate_opts || {}, system, user, vars,
    temperature: j.temperature,
    request: M.aiRequest.buildAiRequest({ provider: cfg.aiProvider, model: cfg.aiModel, system, user, maxTokens: j.max_tokens, temperature: j.temperature }) } };
});`);
  const aiHttp = (name) => w.http(name, {
    method: 'POST', url: `={{ ${CFG('aiUrl')} }}`,
    headers: [
      ['Authorization', `=Bearer {{ ${CFG('aiProvider')} === 'openai' ? $env.OPENAI_API_KEY : '' }}`],
      ['x-api-key', `={{ ${CFG('aiProvider')} === 'anthropic' ? $env.ANTHROPIC_API_KEY : '' }}`],
      ['anthropic-version', '2023-06-01'],
    ],
    body: '$json.request', timeout: 60000, batch: { size: 3, interval: 500 }, notes: 'AI provider set by AI_PROVIDER / AI_MODEL',
  });
  aiHttp('AI request');
  const parseCode = (source) => `
const cfg = $('Config').first().json.cfg;
const src = $('${source}').all();
return $input.all().map((it, i) => {
  const req = src[i].json;
  const text = M.parseAiJson.extractAiText(it.json, cfg.aiProvider);
  const parsed = M.parseAiJson.parseAiJson(text);
  if (parsed.ok) parsed.data = M.validators.prepareByPrompt(req.prompt_id, parsed.data, req.validate_opts, M.validateEmails);
  const v = parsed.ok ? M.validators.validateByPrompt(req.prompt_id, parsed.data, req.validate_opts, M.validateEmails) : { ok: false, errors: [parsed.error] };
  if (parsed.ok && v.ok && req.prompt_id === 'quality_check') parsed.data.score = M.validators.qualityScore(parsed.data, { summary: (req.vars || {}).company_summary, sequence: (req.vars || {}).sequence, generic: [(req.vars || {}).industry, (req.vars || {}).city] }); // computed + quote verified, not the model's guess
  const usage = M.parseAiJson.extractUsage(it.json);
  return { json: Object.assign({}, req, { ok: v.ok, data: parsed.ok ? parsed.data : null, errors: v.errors, raw: String(text).slice(0, 8000),
    cost_eur: (req.cost_eur || 0) + M.aiRequest.estimateCostEur(cfg.aiModel, usage), attempts: (req.attempts || 0) + 1 }) };
});`;
  const mods = ['parseAiJson', 'validators', 'validateEmails', 'aiRequest'];
  w.code('Parse + validate', mods, parseCode('Build request'));
  w.ifTrue('Valid?', '$json.ok');
  w.at(5, 1);
  w.code('Build retry', ['aiRequest'], `
const cfg = $('Config').first().json.cfg;
return $input.all().map((it) => {
  const j = it.json;
  // give the model its own previous answer and ask for a targeted fix (live: rewriting from scratch made new mistakes)
  const prev = j.raw ? '\\n\\nDeine letzte Antwort:\\n' + j.raw : '';
  const user = j.user + prev + '\\n\\nDiese Antwort war ungültig: ' + (j.errors || []).join('; ') + '. Behalte alles andere bei und ändere nur die genannten Stellen. Antworte erneut, ausschließlich mit gültigem JSON im geforderten Format.';
  return { json: Object.assign({}, j, { user, request: M.aiRequest.buildAiRequest({ provider: cfg.aiProvider, model: cfg.aiModel, system: j.system, user, temperature: j.temperature }) }) };
});`);
  aiHttp('AI retry');
  w.code('Parse retry', mods, parseCode('Build retry'));
  w.at(8, 0);
  w.merge('Merge');
  w.code('Result', [], `
return $input.all().map((it) => ({ json: { ref: it.json.ref, prompt_id: it.json.prompt_id, ok: it.json.ok, data: it.json.data, errors: it.json.errors, attempts: it.json.attempts, cost_eur: it.json.cost_eur } }));`);
  w.chain('When called', 'Config', 'Build request', 'AI request', 'Parse + validate', 'Valid?');
  w.connect('Valid?', 'Merge', 0, 0);
  w.connect('Valid?', 'Build retry', 1);
  w.chain('Build retry', 'AI retry', 'Parse retry');
  w.connect('Parse retry', 'Merge', 0, 1);
  w.connect('Merge', 'Result');
  return w;
}

function slackNotify() {
  const w = new Workflow('15_slack_notify', 'Nexsale 15 – Slack notify', { description: 'Posts or updates a Slack message with the bot token; fails loudly when Slack says ok:false.' });
  w.subTrigger('When called');
  w.config();
  w.code('Prepare', [], `
const cfg = $('Config').first().json.cfg;
return $('When called').all().map((i) => i.json).filter((j) => j && j.ref && !j.skip).map((j) => ({ json: {
  ref: j.ref,
  method: j.update_ts ? 'chat.update' : 'chat.postMessage',
  body: Object.assign({ channel: j.channel || cfg.slackChannel, text: j.text || '', unfurl_links: false }, j.blocks ? { blocks: j.blocks } : {}, j.update_ts ? { ts: j.update_ts } : {}),
} }));`);
  w.http('Slack API', {
    method: 'POST', url: `={{ ${CFG('slackApiUrl')} }}/{{ $json.method }}`,
    headers: [['Authorization', '=Bearer {{ $env.SLACK_BOT_TOKEN }}']], body: '$json.body', batch: { size: 1, interval: 1100 },
  });
  w.code('Check ok', [], `
const prep = $('Prepare').all();
return $input.all().map((it, i) => {
  if (!it.json.ok) throw new Error('Slack ' + prep[i].json.method + ' failed: ' + (it.json.error || 'unknown error'));
  return { json: { ref: prep[i].json.ref, ts: it.json.ts, channel: it.json.channel } };
});`);
  w.chain('When called', 'Config', 'Prepare', 'Slack API', 'Check ok');
  return w;
}

module.exports = [errorHandler, sendEmail, aiCall, slackNotify];
