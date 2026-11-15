/**
 * slackSignature.js – verifies Slack request signatures (v0 HMAC-SHA256).
 * https://api.slack.com/authentication/verifying-requests-from-slack
 * `crypto` is passed in so the same code runs in Jest and in an n8n Code node.
 */
const MAX_AGE_SECONDS = 300;

function timingSafeEqualStr(a, b, crypto) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

function signSlack(signingSecret, timestamp, rawBody, crypto) {
  const base = `v0:${timestamp}:${rawBody}`;
  return 'v0=' + crypto.createHmac('sha256', signingSecret).update(base, 'utf8').digest('hex');
}

function verifySlackSignature(opts) {
  const { signingSecret, timestamp, rawBody, signature, crypto } = opts || {};
  const now = opts && opts.now !== undefined ? opts.now : Math.floor(Date.now() / 1000);
  if (!signingSecret) return { ok: false, reason: 'signing secret not configured' };
  if (!timestamp || !signature) return { ok: false, reason: 'missing signature headers' };
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'bad timestamp' };
  if (Math.abs(now - ts) > MAX_AGE_SECONDS) return { ok: false, reason: 'request too old' };
  const expected = signSlack(signingSecret, timestamp, rawBody || '', crypto);
  if (!timingSafeEqualStr(expected, signature, crypto)) return { ok: false, reason: 'signature mismatch' };
  return { ok: true };
}

/** Slack sends application/x-www-form-urlencoded "payload=<json>". */
/** Slack sends application/x-www-form-urlencoded "payload=<json>" (no URLSearchParams in n8n). */
function parseSlackPayload(rawBody) {
  const pairs = String(rawBody || '').split('&');
  for (const pair of pairs) {
    const i = pair.indexOf('=');
    if (i < 0 || pair.slice(0, i) !== 'payload') continue;
    try {
      return JSON.parse(decodeURIComponent(pair.slice(i + 1).replace(/\+/g, ' ')));
    } catch (e) {
      return null;
    }
  }
  return null;
}

const slackSignatureApi = { MAX_AGE_SECONDS, signSlack, verifySlackSignature, parseSlackPayload };
if (typeof module !== 'undefined' && module.exports) module.exports = slackSignatureApi;
