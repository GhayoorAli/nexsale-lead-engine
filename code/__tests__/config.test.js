const C = require('../config');

test('TEST_LEAD_LIMIT=20 from .env is read as 20', () => {
  expect(C.buildConfig({ TEST_LEAD_LIMIT: '20' }).testLeadLimit).toBe(20);
});

test('safe defaults: demo mode on, 10 lead limit, no mock', () => {
  const c = C.buildConfig({});
  expect(c.demoMode).toBe(true);
  expect(c.testLeadLimit).toBe(10);
  expect(c.mock).toBe(false);
  expect(c.allowRealSending).toBe(false);
  expect(c.autoReplyMinConfidence).toBe(0.85);
  expect(c.timezone).toBe('Europe/Berlin');
  expect(c.airtableUrl).toBe('https://api.airtable.com/v0/');
  expect(c.aiUrl).toBe('https://api.openai.com/v1/chat/completions');
  expect(c.webProxyUrl).toBe('');
  expect(c.calendlyApiUrl).toBe('https://api.calendly.com');
  expect(C.buildConfig().demoMode).toBe(true);
});

test('MOCK_EXTERNAL=true points every service at the mock server', () => {
  const c = C.buildConfig({ MOCK_EXTERNAL: 'true', MOCK_BASE_URL: 'http://m:1/', AIRTABLE_BASE_ID: 'appX' });
  expect(c.airtableUrl).toBe('http://m:1/airtable/v0/appX');
  expect(c.googlePlacesUrl).toBe('http://m:1/google/v1');
  expect(c.slackApiUrl).toBe('http://m:1/slack/api');
  expect(c.gmailUrl).toBe('http://m:1/gmail/v1');
  expect(c.hubspotUrl).toBe('http://m:1/hubspot');
  expect(c.webProxyUrl).toBe('http://m:1/web');
  expect(c.calendlyApiUrl).toBe('http://m:1/calendly');
  expect(C.buildConfig({ MOCK_EXTERNAL: 'true' }).airtableUrl).toMatch(/^http:\/\/host.docker.internal:8787/);
});

test('secrets are never part of the config output', () => {
  const c = C.buildConfig({ AIRTABLE_PAT: 'patSECRET', OPENAI_API_KEY: 'sk-SECRET', SLACK_BOT_TOKEN: 'xoxb-SECRET', HUBSPOT_TOKEN: 'pat-SECRET' });
  expect(JSON.stringify(c)).not.toMatch(/SECRET/);
});

test('real mode needs two explicit switches', () => {
  expect(C.buildConfig({ DEMO_MODE: 'false' }).allowRealSending).toBe(false);
  expect(C.buildConfig({ DEMO_MODE: 'false', ALLOW_REAL_SENDING: 'true' }).allowRealSending).toBe(true);
  expect(C.buildConfig({ DEMO_MODE: 'true', ALLOW_REAL_SENDING: 'true' }).allowRealSending).toBe(false);
  expect(C.buildConfig({ DEMO_MODE: 'false' }).testLeadLimit).toBeNull();
});

test('limits, lists, provider, confidence', () => {
  expect(C.parseLimit('off', true)).toBeNull();
  expect(C.parseLimit('25', true)).toBe(25);
  expect(C.parseLimit('abc', true)).toBe(10);
  expect(C.parseList('A@x.de, b@y.de;c@z.de')).toEqual(['a@x.de', 'b@y.de', 'c@z.de']);
  const a = C.buildConfig({ AI_PROVIDER: 'Anthropic', AUTO_REPLY_MIN_CONFIDENCE: '0.9', AIRTABLE_BASE_ID: 'appB' });
  expect(a.aiProvider).toBe('anthropic');
  expect(a.aiUrl).toMatch(/anthropic.com\/v1\/messages$/);
  expect(a.aiModel).toMatch(/claude/);
  expect(a.autoReplyMinConfidence).toBe(0.9);
  expect(a.interfaceUrl).toBe('https://airtable.com/appB');
});

test('demo ticker and per-run cap', () => {
  expect(C.buildConfig({}).demoTicker).toBe(true);
  expect(C.buildConfig({ DISABLE_DEMO_TICKER: 'true' }).demoTicker).toBe(false);
  expect(C.buildConfig({}).maxSendsPerRun).toBe(10); // demo: 10 per minute tick (user decision 2026-11-15)
  expect(C.buildConfig({ DEMO_MODE: 'false' }).maxSendsPerRun).toBe(5);
});

test('webUrl', () => {
  expect(C.webUrl({ webProxyUrl: '' }, 'firma.de', '/impressum')).toBe('https://firma.de/impressum');
  expect(C.webUrl({ webProxyUrl: 'http://m/web' }, 'firma.de')).toBe('http://m/web/firma.de/');
});
