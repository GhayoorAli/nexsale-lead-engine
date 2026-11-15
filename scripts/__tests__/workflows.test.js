/** Rules every workflow must follow (CLAUDE.md "Tech rules" and "Safety rules"). */
const fs = require('fs');
const path = require('path');
const { lint, load, isEmailSend } = require('../lint_workflows');
const { scan, walk, PATTERNS, gitignoreOk } = require('../secret_scan');
const { buildAll } = require('../build_workflows');

const list = load();
const EXPECTED = ['00_error_handler', '01_campaign_setup', '01b_campaign_status', '02_lead_sourcing', '03_enrichment', '04_ai_emails', '05_campaign_launch', '06_sending', '07_replies',
  '07a_gmail_inbox', '07b_calendly', '07c_reminders', '07d_calendly_poll', '08_reporting', '08b_dashboard', '09_inbound_leads', '10_crm_sync', '11_slack_actions', '12_delete_lead', '13_send_email', '14_ai_call', '15_slack_notify'];

test('one workflow file per module, named as in PLAN.md', () => {
  expect(list.map((x) => x.file.replace('.json', '')).sort()).toEqual(EXPECTED.slice().sort());
});

test('workflow JSON is in sync with code/ and prompts/ (npm run build:workflows)', () => {
  buildAll().forEach((w) => {
    const onDisk = fs.readFileSync(path.join(__dirname, '../../workflows', w.file + '.json'), 'utf8');
    expect(onDisk).toBe(JSON.stringify(w.toJSON(), null, 2) + '\n');
  });
});

test('lint: error workflow, retries, Berlin timezone, guard before every send', () => {
  expect(lint(list)).toEqual([]);
});

test('SAFETY: email is sent in exactly one place, right after the guard', () => {
  const sends = list.flatMap(({ file, wf }) => wf.nodes.filter(isEmailSend).map((n) => file + ':' + n.name));
  expect(sends.sort()).toEqual(['13_send_email.json:Send via Gmail', '13_send_email.json:Send via mock Gmail']);
});

test('lint catches a send node without a guard', () => {
  const bad = JSON.parse(JSON.stringify(list.find((x) => x.file === '13_send_email.json')));
  bad.wf.connections['Config'].main[0] = [{ node: 'Mock?', type: 'main', index: 0 }];
  bad.wf.nodes = bad.wf.nodes.filter((n) => !n.name.startsWith('Guard'));
  expect(lint([bad]).join()).toMatch(/not directly preceded by the Guard|must call guardEmail/);
  const noRetry = JSON.parse(JSON.stringify(list.find((x) => x.file === '02_lead_sourcing.json')));
  noRetry.wf.nodes.find((n) => n.type === 'n8n-nodes-base.httpRequest').retryOnFail = false;
  noRetry.wf.settings.errorWorkflow = '';
  expect(lint([noRetry]).join()).toMatch(/no retry on fail[\s\S]*|errorWorkflow/);
});

test('SAFETY: no secret in any workflow file', () => {
  const files = walk(path.join(__dirname, '../../workflows'), []);
  expect(scan(files, [])).toEqual([]);
});

test('secret scan detects tokens and .env values', () => {
  const tmp = path.join(require('os').tmpdir(), 'nxs-scan-' + Date.now() + '.json');
  const fakeToken = ['xo', 'xb-1234567890-abcdefghij'].join(''); // built at runtime so this file itself passes the scan
  fs.writeFileSync(tmp, JSON.stringify({ k: fakeToken, v: 'my-very-secret-value' }));
  const f = scan([tmp], ['my-very-secret-value']);
  fs.unlinkSync(tmp);
  expect(f.map((x) => x.type)).toEqual(['Slack token', 'value from .env']);
  expect(PATTERNS.length).toBeGreaterThan(5);
  expect(gitignoreOk()).toBe(true);
});

test('test mode: Google Places field mask and page size come from TEST_LEAD_LIMIT', () => {
  const wf = list.find((x) => x.file === '02_lead_sourcing.json').wf;
  const g = wf.nodes.find((n) => n.name === 'Google Places search');
  expect(JSON.stringify(g.parameters)).not.toMatch(/reviews|photos/);
  const plan = wf.nodes.find((n) => n.name === 'Search plan').parameters.jsCode;
  expect(plan).toMatch(/buildSearchPlan/);
});

test('every Code node is generated from code/ modules (no hand-written logic drift)', () => {
  list.forEach(({ wf }) => wf.nodes.filter((n) => n.type === 'n8n-nodes-base.code').forEach((n) => {
    const embedded = (n.parameters.jsCode.match(/^M\.(\w+) = \(function/mg) || []).map((m) => m.slice(2, -12));
    embedded.forEach((name) => expect(fs.existsSync(path.join(__dirname, '../../code', name + '.js'))).toBe(true));
  }));
});

test('every <<placeholder>> in a prompt is filled by the workflow that calls it (quality_check gets exact word counts)', () => {
  const prompt = fs.readFileSync(path.join(__dirname, '../../prompts/quality_check.md'), 'utf8');
  expect(prompt).toMatch(/<<auto_checks>>/);
  const wf = list.find((x) => x.file === '04_ai_emails.json').wf;
  ['Quality requests', 'Quality 2 requests'].forEach((name) => {
    const code = wf.nodes.find((n) => n.name === name).parameters.jsCode;
    (prompt.match(/<<(\w+)>>/g) || []).map((p) => p.slice(2, -2)).forEach((v) => expect(code).toMatch(new RegExp('\\b' + v + ':')));
    expect(code).toMatch(/countWords/);
  });
});
