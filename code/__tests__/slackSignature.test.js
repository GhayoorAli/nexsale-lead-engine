const crypto = require('crypto');
const S = require('../slackSignature');

const secret = 'test_signing_secret_not_real';
const body = 'payload=' + encodeURIComponent(JSON.stringify({ type: 'block_actions' }));
const now = 1763110000;
const sig = S.signSlack(secret, now, body, crypto);

test('accepts a valid signature', () => {
  expect(S.verifySlackSignature({ signingSecret: secret, timestamp: String(now), rawBody: body, signature: sig, now, crypto })).toEqual({ ok: true });
});
test('rejects a wrong signature', () => {
  const r = S.verifySlackSignature({ signingSecret: secret, timestamp: String(now), rawBody: body + 'x', signature: sig, now, crypto });
  expect(r).toEqual({ ok: false, reason: 'signature mismatch' });
  expect(S.verifySlackSignature({ signingSecret: secret, timestamp: String(now), rawBody: body, signature: 'v0=abc', now, crypto }).ok).toBe(false);
});
test('rejects an old request (replay)', () => {
  const r = S.verifySlackSignature({ signingSecret: secret, timestamp: String(now - 301), rawBody: body, signature: S.signSlack(secret, now - 301, body, crypto), now, crypto });
  expect(r.reason).toBe('request too old');
});
test('rejects missing headers, bad timestamp, missing secret', () => {
  expect(S.verifySlackSignature({ signingSecret: secret, crypto, now }).reason).toBe('missing signature headers');
  expect(S.verifySlackSignature({ signingSecret: secret, timestamp: 'abc', signature: 'v0=1', crypto, now }).reason).toBe('bad timestamp');
  expect(S.verifySlackSignature({ timestamp: '1', signature: 'v0=1', crypto }).reason).toBe('signing secret not configured');
  expect(S.verifySlackSignature().ok).toBe(false);
});
test('uses current time by default', () => {
  const ts = Math.floor(Date.now() / 1000);
  expect(S.verifySlackSignature({ signingSecret: secret, timestamp: String(ts), rawBody: body, signature: S.signSlack(secret, ts, body, crypto), crypto }).ok).toBe(true);
});
test('parseSlackPayload', () => {
  expect(S.parseSlackPayload(body)).toEqual({ type: 'block_actions' });
  expect(S.parseSlackPayload('payload=%7Bbad')).toBeNull();
  expect(S.parseSlackPayload('')).toBeNull();
});
