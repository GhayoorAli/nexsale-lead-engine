/**
 * validators.js – validates the JSON returned by each AI prompt (one validator per prompt id).
 * Used by the shared AI sub-workflow (14_ai_call): invalid output is retried once.
 * Depends on validateEmails.js (passed in as `ve` so the module also works inside n8n).
 */
const REPLY_CATEGORIES = ['Interested', 'Question', 'Referral', 'Later', 'Not interested', 'Unsubscribe', 'Out of office', 'Unclear'];

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function isIsoDateOrNull(v) {
  return v === null || v === undefined || v === '' || /^\d{4}-\d{2}-\d{2}/.test(String(v));
}

function validateClassification(d) {
  const errors = [];
  if (!d || typeof d !== 'object') return ['not an object'];
  if (!REPLY_CATEGORIES.includes(d.category)) errors.push('category must be one of ' + REPLY_CATEGORIES.join(', '));
  const c = Number(d.confidence);
  if (!Number.isFinite(c) || c < 0 || c > 1) errors.push('confidence must be a number 0..1');
  if (!isIsoDateOrNull(d.return_date)) errors.push('return_date must be YYYY-MM-DD or null');
  if (!isNonEmptyString(d.summary)) errors.push('summary missing');
  ['referral_name', 'referral_email'].forEach((k) => { if (d[k] !== undefined && d[k] !== null && typeof d[k] !== 'string') errors.push(k + ' must be text'); });
  return errors;
}

/**
 * Quality check answers concrete questions with quoted evidence; the score is computed here, not by the model
 * (live test: the model's own 0–100 score for the same sequence varied 70–85 between runs).
 *   opening_specific (bool) 35 · no invented_claims 35 (any invented claim = 0) ·
 *   emails_with_company_detail (steps) 5 each, max 20 · no filler_phrases 10
 */
const GENERIC_DETAIL_WORDS = ['berlin', 'reinigung', 'reinigungsfirma', 'reinigungsunternehmen', 'gebäudereinigung', 'unternehmen', 'firma', 'dienstleistungen',
  'leistungen', 'kunden', 'professionelle', 'umfassende', 'zuverlässige', 'qualität', 'service', 'services'];

function words(t) {
  return String(t || '').toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, ' ').split(/\s+/).filter(Boolean);
}

/** First sentence of email 1 after the salutation, from the "E-Mail 1 … Betreff … body" text the checker saw. */
function openingSentence(sequenceText) {
  const m = String(sequenceText || '').match(/E-Mail 1\s*\n(?:Betreff:[^\n]*\n)?([\s\S]*?)(?:\n\s*E-Mail 2|$)/);
  const body = (m ? m[1] : '').replace(/^\s*(Guten Tag|Sehr geehrte[rs]?|Hallo|Liebe[rs]?)[^\n,]*,?\s*/i, '').trim();
  return (body.match(/^[\s\S]*?[.?!–](\s|$)/) || [body])[0];
}

/**
 * The opening counts as specific only if the quoted detail (opening_detail) really appears in the company
 * description AND in the first sentence, and contains at least one distinctive word (not "Berlin", "Reinigung"…).
 * Live negative control: the model said "Unternehmen wie Ihres profitieren…" was specific – this check says no.
 */
function verifiedOpening(d, ctx) {
  if (d.opening_specific !== true) return false;
  if (!ctx) return true;
  const detail = words(d.opening_detail);
  if (!detail.length) return false;
  const summary = ' ' + words(ctx.summary).join(' ') + ' ';
  const opening = ' ' + words(openingSentence(ctx.sequence)).join(' ') + ' ';
  // the campaign's own industry and city are never a distinctive detail ("Sie sind Steuerberater in Hamburg")
  const campaignWords = words((ctx.generic || []).join(' '));
  const stem = (x) => x.slice(0, 8); // "steuerberater" ~ "steuerberatung", "reinigungsunternehmen" ~ "reinigungsfirma"
  const isGeneric = (w) => GENERIC_DETAIL_WORDS.includes(w) || campaignWords.some((g) => g.length >= 4 && (w === g || stem(w) === stem(g)));
  const distinctive = detail.filter((w) => w.length >= 5 && !isGeneric(w));
  return distinctive.length > 0 && distinctive.every((w) => summary.includes(' ' + w + ' ') || summary.includes(w)) &&
    distinctive.some((w) => opening.includes(w));
}

/**
 * Quality check answers concrete questions with quoted evidence; the score is computed here, not by the model
 * (live test: the model's own 0–100 score for the same sequence varied 70–85 between runs).
 *   verified specific opening 35 · no invented_claims 35 (any invented claim = 0) ·
 *   emails_with_company_detail (steps) 5 each, max 20 · no filler_phrases 10
 * ctx (optional): {summary, sequence} to verify the opening quote.
 */
function qualityScore(d, ctx) {
  if (!d || typeof d !== 'object') return 0;
  const steps = Array.isArray(d.emails_with_company_detail) ? new Set(d.emails_with_company_detail.map(Number).filter((n) => n >= 1 && n <= 4)).size : 0;
  // fail-safe: a missing answer earns nothing (an absent list is not "no invented claims")
  return (verifiedOpening(d, ctx) ? 35 : 0) +
    (Array.isArray(d.invented_claims) && d.invented_claims.length === 0 ? 35 : 0) +
    Math.min(20, steps * 5) +
    (Array.isArray(d.filler_phrases) && d.filler_phrases.length === 0 ? 10 : 0);
}

function validateQuality(d) {
  const errors = [];
  if (!d || typeof d !== 'object') return ['not an object'];
  if (typeof d.opening_specific !== 'boolean') errors.push('opening_specific must be true/false');
  ['invented_claims', 'filler_phrases', 'emails_with_company_detail'].forEach((k) => { if (!Array.isArray(d[k])) errors.push(k + ' must be an array'); });
  if (d.issues !== undefined && !Array.isArray(d.issues)) errors.push('issues must be an array');
  return errors;
}

function validateSummary(d) {
  if (!d || !isNonEmptyString(d.summary)) return ['summary missing'];
  const errors = d.summary.length > 600 ? ['summary too long'] : [];
  // contacts and trigger are optional (older answers without them stay valid); their content is verified in contacts.js
  if (d.contacts !== undefined && !Array.isArray(d.contacts)) errors.push('contacts must be a list');
  if (d.trigger !== undefined && d.trigger !== null && typeof d.trigger !== 'string') errors.push('trigger must be text');
  return errors;
}

function validateImpressumFallback(d) {
  if (!d || typeof d !== 'object') return ['not an object'];
  const errors = [];
  ['contact_name', 'contact_role', 'email'].forEach((k) => {
    if (d[k] !== null && d[k] !== undefined && typeof d[k] !== 'string') errors.push(k + ' must be string or null');
  });
  return errors;
}

function validateBrief(d) {
  const errors = [];
  if (!d || typeof d !== 'object') return ['not an object'];
  if (!['hot', 'warm', 'cold'].includes(String(d.temperature || '').toLowerCase())) errors.push('temperature must be hot, warm or cold');
  if (!isNonEmptyString(d.brief)) errors.push('brief missing');
  return errors;
}

function validateWeekly(d) {
  if (!d || !isNonEmptyString(d.summary)) return ['summary missing'];
  const lines = d.summary.split('\n').filter((l) => l.trim());
  return lines.length > 7 ? ['summary must be about 5 lines'] : [];
}

function validateInterestedReply(d, opts, ve) {
  const errors = [];
  if (!d || typeof d !== 'object') return ['not an object'];
  if (!isNonEmptyString(d.body)) return ['body missing'];
  if (opts && opts.calendlyLink && !d.body.includes(opts.calendlyLink)) errors.push('calendly link missing');
  if (ve && ve.hasInformal(d.body)) errors.push('informal "du" form');
  if (ve && ve.hasPlaceholder(d.body)) errors.push('leftover placeholder');
  return errors;
}

function validateEmailSequence(d, opts, ve) {
  const seq = ve.normaliseSequence(d);
  if (!seq) return ['expected {"emails": [...]}'];
  const errors = ve.validateSequence(seq, { footer: opts && opts.footer, senderName: opts && opts.senderName }).errors;
  const first = (d.emails || []).find((e) => Number(e && e.step) === 1);
  const alt = first && String(first.subject_alt || '').trim();
  if (alt && ve.countWords(alt) > ve.MAX_SUBJECT_WORDS) errors.push(`step 1: subject_alt has ${ve.countWords(alt)} words (max ${ve.MAX_SUBJECT_WORDS})`);
  return errors;
}

function validateReferralIntro(d, opts, ve) {
  if (!d || typeof d !== 'object') return ['not an object'];
  if (!isNonEmptyString(d.body)) return ['body missing'];
  if (!isNonEmptyString(d.subject)) return ['subject missing'];
  return ve ? ve.validateEmail({ step: 1, subject: d.subject, body: d.body }, { senderName: opts && opts.senderName }) : [];
}

function validateMeetingBrief(d) {
  if (!d || typeof d !== 'object') return ['not an object'];
  const errors = [];
  if (!isNonEmptyString(d.about)) errors.push('about missing');
  if (!Array.isArray(d.questions_to_ask) || d.questions_to_ask.length < 1 || d.questions_to_ask.some((q) => !isNonEmptyString(q))) errors.push('questions_to_ask: 1+ questions');
  ['why_now', 'conversation'].forEach((k) => { if (d[k] !== undefined && d[k] !== null && typeof d[k] !== 'string') errors.push(k + ' must be text'); });
  return errors;
}

const VALIDATORS = {
  meeting_brief: validateMeetingBrief,
  referral_intro: validateReferralIntro,
  email_sequence: validateEmailSequence,
  quality_check: validateQuality,
  reply_classifier: validateClassification,
  company_summary: validateSummary,
  impressum_fallback: validateImpressumFallback,
  inbound_lead_brief: validateBrief,
  weekly_report: validateWeekly,
  interested_reply: validateInterestedReply,
};

/** Deterministic clean-up before validation: the same salutation + signature frame on every email we write. */
function prepareByPrompt(promptId, data, opts, ve) {
  if ((promptId === 'interested_reply' || promptId === 'referral_intro') && ve && data && typeof data.body === 'string' && opts && opts.frame) {
    return Object.assign({}, data, { body: ve.ensureFrame(data.body.replace(/\\n/g, '\n'), opts) });
  }
  if (promptId !== 'email_sequence' || !ve || !data || !Array.isArray(data.emails)) return data;
  return Object.assign({}, data, { emails: data.emails.map((e) => Object.assign({}, e, { body: ve.ensureFrame(String(e.body || '').replace(/\\n/g, '\n'), opts || {}) })) });
}

function validateByPrompt(promptId, data, opts, ve) {
  const fn = VALIDATORS[promptId];
  if (!fn) return { ok: false, errors: ['unknown prompt id ' + promptId] };
  const errors = fn(data, opts || {}, ve);
  return { ok: errors.length === 0, errors };
}

const validatorsApi = { REPLY_CATEGORIES, prepareByPrompt, validateByPrompt, VALIDATORS, qualityScore, verifiedOpening, openingSentence };
if (typeof module !== 'undefined' && module.exports) module.exports = validatorsApi;
