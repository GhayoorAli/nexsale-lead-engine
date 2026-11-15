/**
 * config.js – builds the runtime config for every workflow from environment variables.
 * Used by the first "Config" Code node in each workflow. Secrets are NOT copied into
 * the output (execution data is stored in n8n); HTTP nodes read tokens from $env directly.
 */
function bool(v, dflt) {
  if (v === undefined || v === null || v === '') return dflt;
  return String(v).trim().toLowerCase() === 'true';
}

function parseList(v) {
  return String(v || '')
    .split(/[,;\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function parseLimit(v, demoMode) {
  if (v === undefined || v === null || v === '') return demoMode ? 10 : null;
  if (String(v).trim().toLowerCase() === 'off') return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : 10;
}

function trimSlash(u) {
  return String(u || '').replace(/\/+$/, '');
}

function buildConfig(env) {
  env = env || {};
  // Safe defaults: demo mode ON unless explicitly "false".
  const demoMode = bool(env.DEMO_MODE, true);
  const mock = bool(env.MOCK_EXTERNAL, false);
  const mockBase = trimSlash(env.MOCK_BASE_URL || 'http://host.docker.internal:8787');
  const real = {
    airtable: 'https://api.airtable.com/v0',
    googlePlaces: 'https://places.googleapis.com/v1',
    openai: 'https://api.openai.com/v1',
    anthropic: 'https://api.anthropic.com/v1',
    slack: 'https://slack.com/api',
    gmail: 'https://gmail.googleapis.com/gmail/v1',
    hubspot: 'https://api.hubapi.com',
    dns: 'https://dns.google',
    web: '',
    calendly: 'https://api.calendly.com',
  };
  const mocked = {
    airtable: mockBase + '/airtable/v0',
    googlePlaces: mockBase + '/google/v1',
    openai: mockBase + '/ai/openai/v1',
    anthropic: mockBase + '/ai/anthropic/v1',
    slack: mockBase + '/slack/api',
    gmail: mockBase + '/gmail/v1',
    hubspot: mockBase + '/hubspot',
    dns: mockBase + '/dns',
    web: mockBase + '/web',
    calendly: mockBase + '/calendly',
  };
  const urls = mock ? mocked : real;
  const aiProvider = String(env.AI_PROVIDER || 'openai').toLowerCase() === 'anthropic' ? 'anthropic' : 'openai';
  const allowlist = parseList(env.TEST_RECIPIENT_ALLOWLIST);
  const conf = parseFloat(env.AUTO_REPLY_MIN_CONFIDENCE);
  return {
    demoMode,
    mock,
    allowRealSending: !demoMode && bool(env.ALLOW_REAL_SENDING, false),
    // DEMO_MODE sends from an every-minute ticker; the test stack turns it off and drives sends by webhook
    demoTicker: !bool(env.DISABLE_DEMO_TICKER, false),
    // cap per run so one run always finishes before the next tick (no overlapping runs)
    maxSendsPerRun: demoMode ? 6 : 5,
    testLeadLimit: parseLimit(env.TEST_LEAD_LIMIT, demoMode),
    allowlist,
    testProspectEmail: String(env.TEST_PROSPECT_EMAIL || '').trim().toLowerCase(),
    senderEmail: String(env.SENDER_EMAIL || '').trim().toLowerCase(),
    autoReplyMinConfidence: Number.isFinite(conf) ? conf : 0.85,
    unsureConfidence: 0.7,
    timezone: 'Europe/Berlin',
    airtableBaseId: env.AIRTABLE_BASE_ID || '',
    airtableUrl: urls.airtable + '/' + (env.AIRTABLE_BASE_ID || ''),
    googlePlacesUrl: urls.googlePlaces,
    aiProvider,
    aiModel: env.AI_MODEL || (aiProvider === 'anthropic' ? 'claude-haiku-5-5' : 'gpt-4o-mini'),
    aiUrl: aiProvider === 'anthropic' ? urls.anthropic + '/messages' : urls.openai + '/chat/completions',
    slackApiUrl: urls.slack,
    slackChannel: env.SLACK_CHANNEL || '#leads',
    gmailUrl: urls.gmail,
    hubspotUrl: urls.hubspot,
    dnsUrl: urls.dns,
    webProxyUrl: urls.web,
    calendlyLink: env.CALENDLY_LINK || '',
    calendlyApiUrl: urls.calendly,
    n8nBaseUrl: trimSlash(env.WEBHOOK_URL || 'http://localhost:5678'),
    n8nInternalUrl: trimSlash(env.N8N_INTERNAL_URL || 'http://localhost:5678'),
    interfaceUrl: env.AIRTABLE_INTERFACE_URL || (env.AIRTABLE_BASE_ID ? 'https://airtable.com/' + env.AIRTABLE_BASE_ID : ''),
    googleCostPerRequestEur: 0.032,
  };
}

/** URL to fetch a company web page; in mock mode served by the mock server. */
function webUrl(cfg, domain, path) {
  path = path || '/';
  if (cfg.webProxyUrl) return cfg.webProxyUrl + '/' + domain + path;
  return 'https://' + domain + path;
}

const configApi = { buildConfig, webUrl, parseList, parseLimit };
if (typeof module !== 'undefined' && module.exports) module.exports = configApi;
