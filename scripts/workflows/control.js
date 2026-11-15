/** Module 16 – the Control Center: one password-protected web app (local only) that runs the whole process. */
const { Workflow, CFG } = require('../n8n_builder');

function controlCenter() {
  const w = new Workflow('16_control_center', 'Nexsale 16 – Control Center', { description: 'GET /webhook/app (pages) and POST /webhook/app-action (actions), HTTP Basic login (CONTROL_USER / CONTROL_PASSWORD). Clients, campaigns (create, launch, pause/resume/stop), leads (exclude, rewrite), replies (approve/edit/reject, sort), meetings, tasks, system. Actions that Slack also offers run through 11_slack_actions (control-action), so both behave identically. Local only: the tunnel lets only Slack clicks through.' });
  w.webhook('Page request', 'app', { method: 'GET', responseMode: 'responseNode' });
  w.at(0, 1);
  w.webhook('Action request', 'app-action', { responseMode: 'responseNode' });
  w.at(1, 0);
  w.code('Login', ['controlCenter'], `
const crypto = require('crypto');
const isAction = $('Action request').isExecuted;
const req = isAction ? $('Action request').first().json : $('Page request').first().json;
const auth = M.controlCenter.checkAuth((req.headers || {}).authorization, $env.CONTROL_USER || 'admin', $env.CONTROL_PASSWORD || '', crypto);
return [{ json: { ok: auth.ok, reason: auth.reason, user: auth.user, isAction, query: req.query || {}, body: req.body || {} } }];`);
  w.ifTrue('Logged in?', '$json.ok');
  w.at(3, 2);
  w.add('Ask for login', 'n8n-nodes-base.respondToWebhook', 1.1, {
    respondWith: 'text', responseBody: "={{ 'Login erforderlich: ' + $json.reason }}",
    options: { responseCode: 401, responseHeaders: { entries: [{ name: 'WWW-Authenticate', value: 'Basic realm="Nexsale Control Center", charset="UTF-8"' }, { name: 'Content-Type', value: 'text/plain; charset=utf-8' }] } },
  });
  w.at(3, 0);
  w.config('Config');
  ['Clients', 'Campaigns', 'Leads', 'Emails', 'Replies', 'Meetings', 'Tasks', 'Logs'].forEach((t) => w.atList(t, t, null, { maxPages: 20 }));
  w.ifTrue('Action?', "$('Login').first().json.isAction");
  // pages
  w.at(12, 1);
  w.code('Render page', ['airtable', 'report', 'dashboard', 'campaign', 'controlCenter'], `
const cfg = $('Config').first().json.cfg;
const l = $('Login').first().json;
const all = (n) => M.airtable.fromItems($(n).all());
const sender = String(cfg.senderEmail || '');
const html = M.controlCenter.renderPage({ page: String(l.query.p || 'overview'), params: l.query, user: l.user, now: new Date().toISOString(),
  data: { clients: all('Clients'), campaigns: all('Campaigns'), leads: all('Leads'), emails: all('Emails'), replies: all('Replies'), meetings: all('Meetings'), tasks: all('Tasks'), logs: all('Logs') },
  cfg: { demoMode: cfg.demoMode, allowRealSending: cfg.allowRealSending, mock: cfg.mock, aiModel: cfg.aiModel, airtableBaseId: cfg.mock ? '' : cfg.airtableBaseId,
    allowlistCount: String($env.TEST_RECIPIENT_ALLOWLIST || '').split(',').filter((x) => x.trim()).length,
    senderMasked: sender ? sender.slice(0, 3) + '…@' + sender.split('@')[1] : '' } });
return [{ json: { html } }];`);
  w.respond('Show page', '$json.html', { html: true });
  // actions
  w.at(12, -1);
  w.code('Plan action', ['airtable', 'campaign', 'controlCenter'], `
const cfg = $('Config').first().json.cfg;
const l = $('Login').first().json;
const all = (n) => M.airtable.fromItems($(n).all());
const plan = M.controlCenter.planAction(l.body, { clients: all('Clients'), campaigns: all('Campaigns'), leads: all('Leads'), emails: all('Emails'), replies: all('Replies'),
  meetings: all('Meetings'), tasks: all('Tasks') }, { user: l.user, defaultMax: cfg.testLeadLimit || 100, now: new Date().toISOString() });
return [{ json: plan }];`);
  w.code('Operations', [], `return ($('Plan action').first().json.ops || []).map((op) => ({ json: op }));`, { alwaysOutputData: false });
  w.ifTrue('Anything to do?', "($('Plan action').first().json.ops || []).length > 0");
  const run = (name) => w.http(name, {
    method: '={{ $json.method || "POST" }}',
    url: `={{ $json.kind === 'kick' ? ${CFG('n8nInternalUrl')} + '/webhook/' + $json.path : ${CFG('airtableUrl')} + '/' + $json.table + ($json.query ? '?' + $json.query : '') }}`,
    headers: [['Authorization', "={{ $json.kind === 'kick' ? '' : 'Bearer ' + $env.AIRTABLE_PAT }}"], ['x-control-key', "={{ $json.kind === 'kick' ? $env.CONTROL_PASSWORD : '' }}"]],
    body: '$json.body || {}', batch: { size: 1, interval: 250 }, timeout: 20000,
    notes: 'Runs the planned Airtable writes in order, then the webhook kicks (control-action, lead-sourcing, ai-emails-run)',
  });
  run('Run operations');
  w.code('After', ['controlCenter'], `
const plan = $('Plan action').first().json;
const results = $('Run operations').isExecuted ? $('Run operations').all().map((i) => i.json) : [];
const a = M.controlCenter.afterAction(plan, results);
return [{ json: a }];`);
  w.code('Follow-up', [], `return ($('After').first().json.ops || []).map((op) => ({ json: op }));`);
  w.ifTrue('Follow-up?', "($('After').first().json.ops || []).length > 0");
  run('Run follow-up');
  w.at(22, -1);
  w.add('Back to page', 'n8n-nodes-base.respondToWebhook', 1.1, { respondWith: 'redirect', redirectURL: "={{ '/webhook/app' + $('After').first().json.redirect }}", options: { responseCode: 303 } });
  w.chain('Page request', 'Login', 'Logged in?');
  w.connect('Action request', 'Login');
  w.connect('Logged in?', 'Config', 0);
  w.connect('Logged in?', 'Ask for login', 1);
  w.chain('Config', 'Clients', 'Campaigns', 'Leads', 'Emails', 'Replies', 'Meetings', 'Tasks', 'Logs', 'Action?');
  w.connect('Action?', 'Plan action', 0);
  w.connect('Action?', 'Render page', 1);
  w.chain('Render page', 'Show page');
  w.chain('Plan action', 'Anything to do?');
  w.connect('Anything to do?', 'Operations', 0);
  w.connect('Anything to do?', 'After', 1);
  w.chain('Operations', 'Run operations', 'After', 'Follow-up?');
  w.connect('Follow-up?', 'Follow-up', 0);
  w.connect('Follow-up?', 'Back to page', 1);
  w.chain('Follow-up', 'Run follow-up', 'Back to page');
  return w;
}

module.exports = [controlCenter];
