/**
 * guard.js – the safety guard that runs right before every email-sending node.
 * - Blocks the run (throws) if any recipient is not on TEST_RECIPIENT_ALLOWLIST.
 * - An empty allowlist blocks everything in test mode.
 * - DEMO_MODE: rewrites To to TEST_PROSPECT_EMAIL, drops Cc/Bcc, prefixes the subject with [TEST].
 * - Real mode (DEMO_MODE=false) additionally needs ALLOW_REAL_SENDING=true, otherwise it blocks.
 */
class GuardError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'GuardError';
    this.details = details || {};
  }
}

function norm(e) {
  return String(e || '').trim().toLowerCase();
}

function splitAddresses(v) {
  if (!v) return [];
  const list = Array.isArray(v) ? v : String(v).split(/[,;]/);
  return list
    .map((x) => {
      const m = String(x).match(/<([^>]+)>/);
      return norm(m ? m[1] : x);
    })
    .filter(Boolean);
}

function guardEmail(msg, cfg) {
  if (!msg || typeof msg !== 'object') throw new GuardError('Guard: no message');
  if (!cfg || typeof cfg !== 'object') throw new GuardError('Guard: no config');
  const original = { to: splitAddresses(msg.to), cc: splitAddresses(msg.cc), bcc: splitAddresses(msg.bcc) };
  if (!original.to.length) throw new GuardError('Guard: message has no recipient');
  const out = Object.assign({}, msg);
  if (cfg.demoMode) {
    if (!cfg.testProspectEmail) throw new GuardError('Guard: DEMO_MODE is on but TEST_PROSPECT_EMAIL is empty');
    out.to = cfg.testProspectEmail;
    out.cc = '';
    out.bcc = '';
    const subj = String(msg.subject || '');
    out.subject = /^\[TEST\]/.test(subj) ? subj : '[TEST] ' + subj;
    out.original_to = original.to.join(', ');
  } else if (!cfg.allowRealSending) {
    throw new GuardError('Guard: DEMO_MODE is off but ALLOW_REAL_SENDING is not true – blocked', { to: original.to });
  }
  const allow = (cfg.allowlist || []).map(norm);
  const finalRecipients = [].concat(splitAddresses(out.to), splitAddresses(out.cc), splitAddresses(out.bcc));
  if (cfg.demoMode || allow.length) {
    if (!allow.length) throw new GuardError('Guard: TEST_RECIPIENT_ALLOWLIST is empty – every send is blocked');
    const bad = finalRecipients.filter((r) => !allow.includes(r));
    if (bad.length) throw new GuardError('Guard: recipient not on allowlist: ' + bad.join(', '), { blocked: bad });
  }
  out.guard = { passed: true, demoMode: !!cfg.demoMode, recipients: finalRecipients, checkedAt: new Date().toISOString() };
  return out;
}

/** Blocklist check: entries are {value} (email or domain) or plain strings. */
function isBlocked(email, blocklist) {
  const e = norm(email);
  if (!e) return false;
  const domain = e.split('@')[1] || '';
  return (blocklist || []).some((entry) => {
    const v = norm(typeof entry === 'string' ? entry : entry && (entry.value || entry.email || entry.domain));
    if (!v) return false;
    if (v.includes('@')) return v === e;
    return v === domain || domain.endsWith('.' + v);
  });
}

const guardApi = { GuardError, guardEmail, isBlocked, splitAddresses };
if (typeof module !== 'undefined' && module.exports) module.exports = guardApi;
