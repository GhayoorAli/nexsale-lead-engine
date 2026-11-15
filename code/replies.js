/**
 * replies.js – Module 7 reply handling: normalise, match to a lead, detect bounces,
 * cheap rule-based pre-classification (STOP, auto-replies) and branch routing.
 */
function addr(v) {
  if (!v) return '';
  if (typeof v === 'object') {
    if (Array.isArray(v.value) && v.value[0]) return String(v.value[0].address || '').toLowerCase();
    if (v.address) return String(v.address).toLowerCase();
    if (v.text) return addr(v.text);
  }
  const m = String(v).match(/<([^>]+)>/);
  return String(m ? m[1] : v).trim().toLowerCase();
}

function stripQuoted(text) {
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  for (const l of lines) {
    if (/^\s*>/.test(l)) break;
    if (/^\s*(Am|On)\s.+(schrieb|wrote)/i.test(l)) break;
    if (/^-{2,}\s*(Original|Ursprüngliche)/i.test(l)) break;
    out.push(l);
  }
  return out.join('\n').trim();
}

/** Newsletters / notifications: list headers, bulk precedence or a typical robot sender. */
function isBulk(msg, headers) {
  const lc = {};
  Object.keys(headers || {}).forEach((k) => (lc[k.toLowerCase()] = headers[k])); // header names are case-insensitive
  const h = (k) => String(lc[k] || '').toLowerCase();
  if (msg && msg.bulk === true) return true;
  if (h('list-unsubscribe') || h('list-id')) return true;
  if (/^(bulk|list|junk)$/.test(h('precedence'))) return true;
  const from = addr((msg && msg.from) || h('from'));
  return /^(no-?reply|do-?not-?reply|newsletter|news|notifications?|notify|onboarding|marketing|mailer|updates|info-noreply)[@.+-]/.test(from);
}

/** Accepts a Gmail Trigger message (simple:false) or the test webhook payload. */
function normaliseIncoming(msg) {
  msg = msg || {};
  const headers = msg.headers || {};
  const lc = {};
  Object.keys(headers).forEach((k) => (lc[k.toLowerCase()] = headers[k])); // header names are case-insensitive
  const h = (k) => lc[k.toLowerCase()] || '';
  const body = msg.text || msg.textPlain || msg.body || msg.snippet || '';
  return {
    message_id: msg.id || msg.message_id || '',
    thread_id: msg.threadId || msg.thread_id || '',
    from_email: addr(msg.from || h('from')),
    to_email: addr(msg.to || h('to')),
    subject: msg.subject || h('subject') || '',
    body: String(body),
    body_clean: stripQuoted(body),
    received_at: msg.date ? new Date(msg.date).toISOString() : msg.received_at || new Date().toISOString(),
    auto_submitted: String(h('auto-submitted') || msg.auto_submitted || '').toLowerCase(),
    bulk: isBulk(msg, headers),
    original_to: addr(msg.original_to || h('x-original-recipient') || ''),
  };
}

function detectBounce(r) {
  const from = String(r.from_email || '');
  const subj = String(r.subject || '');
  if (/mailer-daemon|postmaster@/i.test(from)) return true;
  if (/(Delivery Status Notification|Undeliverable|Unzustellbar|Mail delivery failed|Returned mail|Nicht zustellbar)/i.test(subj)) return true;
  return false;
}

/** Extracts the bounced address from a bounce body. */
function bouncedAddress(r) {
  const m = String(r.body || '').match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || [];
  return (m.find((e) => !/mailer-daemon|postmaster|googlemail\.com$/i.test(e)) || '').toLowerCase();
}

const STOP_RE = /^\s*(stop|stopp|abmelden|unsubscribe|austragen)\s*[.!]?\s*$/i;
const UNSUB_RE = /(keine (weiteren )?(e-?mails|nachrichten|kontaktaufnahme)|bitte (aus (ihrem|dem) verteiler|austragen|löschen sie)|nicht mehr kontaktieren|remove me|unsubscribe|abmelden)/i;
const OOO_RE = /(abwesenheitsnotiz|out of office|nicht im büro|außer haus|im urlaub|bin bis|automatische antwort|auto(matic)?[- ]reply)/i;

/** Parses German/ISO dates like 24.11.2026, 24.11., 2026-11-24. */
function findReturnDate(text, now) {
  const t = String(text || '');
  const iso = t.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const de = t.match(/\b(\d{1,2})\.(\d{1,2})\.(\d{2,4})?/);
  if (de) {
    const ref = new Date(now || Date.now());
    let y = de[3] ? Number(de[3].length === 2 ? '20' + de[3] : de[3]) : ref.getUTCFullYear();
    const m = Number(de[2]);
    const d = Number(de[1]);
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    if (!de[3] && Date.UTC(y, m - 1, d) < ref.getTime() - 86400000) y += 1;
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  return null;
}

/** Deterministic pre-classification; returns null when the AI must decide. */
function ruleClassify(r, now) {
  const body = r.body_clean || r.body || '';
  if (STOP_RE.test(body) || /^\s*stop\b/i.test(body)) return { category: 'Unsubscribe', confidence: 1, return_date: null, summary: 'STOP-Antwort', by: 'rule' };
  const isAuto = /auto-replied|auto-generated/.test(r.auto_submitted || '') || OOO_RE.test(r.subject + ' ' + body.slice(0, 300));
  if (isAuto && OOO_RE.test(r.subject + ' ' + body)) {
    return { category: 'Out of office', confidence: 0.95, return_date: findReturnDate(body, now), summary: 'Abwesenheitsnotiz', by: 'rule' };
  }
  if (UNSUB_RE.test(body) && body.length < 400) return { category: 'Unsubscribe', confidence: 0.95, return_date: null, summary: 'Bittet um Austragung', by: 'rule' };
  return null;
}

/** Thread id first, then sender email. */
function matchReplyToLead(r, leads, emails) {
  leads = leads || [];
  emails = emails || [];
  if (r.thread_id) {
    const em = emails.find((e) => e.thread_id && e.thread_id === r.thread_id);
    if (em) {
      const leadId = Array.isArray(em.lead) ? em.lead[0] : em.lead || em.lead_record_id;
      const lead = leads.find((l) => l.id === leadId);
      if (lead) return { lead, by: 'thread_id' };
    }
  }
  const from = String(r.from_email || '').toLowerCase();
  const candidates = [from, r.original_to].filter(Boolean);
  const lead = leads.find((l) => candidates.includes(String(l.email || '').toLowerCase()));
  if (lead) return { lead, by: 'from_email' };
  return { lead: null, by: null };
}

/**
 * Decides the branch for a classified reply.
 * returns {branch, leadStatus, autoSend, askSlack, nextSendAt, block}
 */
function routeReply(cls, cfg, now) {
  const minAuto = (cfg && cfg.autoReplyMinConfidence) || 0.85;
  const unsure = (cfg && cfg.unsureConfidence) || 0.7;
  const t = new Date(now || Date.now());
  const conf = Number(cls.confidence) || 0;
  if (cls.category === 'Unclear' || conf < unsure) {
    return { branch: 'Unsure', leadStatus: 'Replied', askSlack: true, autoSend: false };
  }
  switch (cls.category) {
    case 'Interested':
      return { branch: 'Interested', leadStatus: 'Interested', autoSend: conf >= minAuto, askSlack: conf < minAuto };
    case 'Question':
      // answers to questions (price, process) are always approved by a person: one wrong answer can cost the client
      return { branch: 'Question', leadStatus: 'Interested', autoSend: false, askSlack: true };
    case 'Referral':
      return { branch: 'Referral', leadStatus: 'Replied' };
    case 'Later': {
      const d = cls.return_date ? new Date(cls.return_date + 'T08:00:00Z') : new Date(t.getTime() + 30 * 86400000);
      return { branch: 'Later', leadStatus: 'Later', followUpAt: d.toISOString() };
    }
    case 'Not interested':
      return { branch: 'Not interested', leadStatus: 'Not interested' };
    case 'Unsubscribe':
      return { branch: 'Unsubscribe', leadStatus: 'Unsubscribed', block: true };
    case 'Out of office': {
      const base = cls.return_date ? new Date(cls.return_date + 'T08:00:00Z') : new Date(t.getTime() + 7 * 86400000);
      const resume = new Date(base.getTime() + 86400000);
      return { branch: 'Out of office', leadStatus: 'Contacted', resumeAt: (cfg && cfg.demoMode) ? new Date(t.getTime() + 5 * 60000).toISOString() : resume.toISOString() };
    }
    default:
      return { branch: 'Unsure', leadStatus: 'Replied', askSlack: true, autoSend: false };
  }
}

/**
 * A lead says no (Not interested / Unsubscribe) after it had shown interest.
 * Plans: which booked meetings to cancel in Airtable, whether the HubSpot deal must be closed, and the Slack text.
 * Calendly itself cannot be cancelled with the read-only token, so Slack asks a person to cancel it there.
 */
function withdrawalPlan(opts) {
  const o = opts || {};
  const lead = o.lead || {};
  const name = lead.company_name || o.fromEmail || 'Lead';
  const booked = (o.meetings || []).filter((m) => m && m.status === 'Booked' && (!lead.id || m.lead_record_id === lead.id));
  const wasInterested = ['Interested', 'Meeting booked', 'Meeting held'].includes(lead.status);
  const hasDeal = !!lead.hubspot_deal_id;
  const closing = o.branch === 'Not interested' || o.branch === 'Unsubscribe';
  const withdrew = closing && (wasInterested || hasDeal || booked.length > 0);
  if (!withdrew) return { withdrew: false, cancelMeetingIds: [], crmSync: false, text: '' };
  const parts = [':leftwards_arrow_with_hook: *' + name + '* withdrew after showing interest (' + (o.branch === 'Unsubscribe' ? 'STOP, added to the Blocklist' : 'not interested') + ').'];
  if (hasDeal) parts.push('HubSpot deal set to Closed lost.');
  booked.forEach((m) => parts.push('Meeting on ' + String(m.start_time || '').slice(0, 16).replace('T', ' ') + ' marked cancelled: *please cancel it in Calendly too*.'));
  return { withdrew: true, cancelMeetingIds: booked.map((m) => m.id), crmSync: hasDeal, text: parts.join(' ') };
}

/**
 * "Wenden Sie sich an Frau Klein, klein@firma.de": contact the named person automatically, but only if the address is in
 * the reply, belongs to the same company (or a related domain), is not blocked and is not already a lead.
 * returns { action: 'contact' | 'task', name, email, reason }
 */
function referralPlan(o) {
  const cls = (o && o.cls) || {};
  const lead = (o && o.lead) || {};
  const body = String((o && o.replyBody) || '').toLowerCase();
  const name = String(cls.referral_name || '').trim();
  const email = String(cls.referral_email || '').trim().toLowerCase();
  const task = (reason) => ({ action: 'task', name, email, reason });
  if (!email) return task('no email address in the reply');
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(email) || !body.includes(email)) return task('email not found in the reply');
  const dom = email.split('@')[1];
  const related = o.relatedDomain ? o.relatedDomain(dom, lead.domain, lead.company_name) : dom === lead.domain;
  if (!related) return task('email is not on the company domain');
  if (o.isBlocked && o.isBlocked(email, o.blocklist || [])) return task('address is on the Blocklist');
  if ((o.existingEmails || []).map((x) => String(x).toLowerCase()).includes(email)) return task('already a lead');
  if (email === String(lead.email || '').toLowerCase()) return task('same address as the original contact');
  return { action: 'contact', name, email, reason: '' };
}

const repliesApi = { isBulk, normaliseIncoming, stripQuoted, detectBounce, bouncedAddress, ruleClassify, findReturnDate, matchReplyToLead, routeReply, withdrawalPlan, referralPlan, addr };
if (typeof module !== 'undefined' && module.exports) module.exports = repliesApi;
