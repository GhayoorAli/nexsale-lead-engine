#!/usr/bin/env node
/**
 * Secret scan (runs in GitHub Actions and before every commit).
 * Fails if a token-like string appears in any tracked-looking file, or if a value from .env
 * (when present) appears outside .env. .env must be listed in .gitignore.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.venv', '.git', 'coverage', '.pytest_cache', '__pycache__', 'n8n_data']);
const SKIP_FILES = new Set(['.env', '.n8n_test_credentials.json', 'package-lock.json']);
const PATTERNS = [
  ['Airtable PAT', /\bpat[A-Za-z0-9]{14}\.[a-f0-9]{64}\b/],
  ['OpenAI key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/],
  ['Anthropic key', /\bsk-ant-[A-Za-z0-9_-]{20,}\b/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ['Slack webhook', /hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['HubSpot token', /\bpat-(?:na|eu)1-[0-9a-f-]{30,}\b/],
  ['Apify token', /\bapify_api_[A-Za-z0-9]{20,}\b/],
  ['Private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['n8n API key (JWT)', /\beyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/],
];

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), out);
    } else if (!SKIP_FILES.has(e.name) && !/\.(png|jpg|jpeg|gif|mp4|ico|pdf)$/i.test(e.name)) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

// plain settings, not secrets or personal data – everything else in .env is scanned (keys, tokens, webhook URLs, emails)
const NON_SECRET_KEYS = new Set(['TZ', 'DEMO_MODE', 'MOCK_EXTERNAL', 'N8N_INTERNAL_URL', 'N8N_EDITOR_BASE_URL', 'AI_PROVIDER', 'AI_MODEL', 'SLACK_CHANNEL',
  'TEST_LEAD_LIMIT', 'WEBHOOK_URL', 'NGROK_DOMAIN', 'COMPOSE_PROFILES', 'AUTO_REPLY_MIN_CONFIDENCE', 'ALLOW_REAL_SENDING', 'DISABLE_SCHEDULES', 'DISABLE_DEMO_TICKER', 'N8N_PORT']);

function envValues() {
  const p = path.join(ROOT, '.env');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n')
    .map((l) => l.replace(/\s+#.*$/, '').trim())
    .filter((l) => /^[A-Z0-9_]+=/.test(l))
    .filter((l) => !NON_SECRET_KEYS.has(l.slice(0, l.indexOf('='))))
    .map((l) => l.slice(l.indexOf('=') + 1).trim())
    .filter((v) => v.length >= 8);
}

function scan(files, values) {
  const findings = [];
  files.forEach((f) => {
    const text = fs.readFileSync(f, 'utf8');
    PATTERNS.forEach(([name, re]) => {
      const m = text.match(re);
      if (m) findings.push({ file: path.relative(ROOT, f), type: name, sample: m[0].slice(0, 12) + '…' });
    });
    values.forEach((v) => {
      if (text.includes(v)) findings.push({ file: path.relative(ROOT, f), type: 'value from .env', sample: v.slice(0, 4) + '…' });
    });
  });
  return findings;
}

function gitignoreOk() {
  const p = path.join(ROOT, '.gitignore');
  return fs.existsSync(p) && fs.readFileSync(p, 'utf8').split('\n').map((l) => l.trim()).includes('.env');
}

if (require.main === module) {
  const files = walk(ROOT, []);
  const findings = scan(files, envValues());
  if (!gitignoreOk()) findings.push({ file: '.gitignore', type: '.env is not ignored', sample: '' });
  if (findings.length) {
    console.error('Secret scan FAILED:');
    findings.forEach((f) => console.error(` - ${f.file}: ${f.type} (${f.sample})`));
    process.exit(1);
  }
  console.log(`Secret scan passed (${files.length} files, ${PATTERNS.length} patterns).`);
}

module.exports = { scan, PATTERNS, walk, gitignoreOk, envValues, NON_SECRET_KEYS };
