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
  'leistungen', 'kunden', 'professionelle', 'umfassende', 'zuverlässige', 'qualität', 'service', 'services',
  // marketing adjectives every company uses about itself (live: "bietet eine ganzheitliche Steuerberatung an" scored 90)
  'ganzheitliche', 'ganzheitlich', 'individuelle', 'individuell', 'persönliche', 'persönlich', 'kompetente', 'kompetent', 'erfahrene',
  'langjährige', 'langjähriger', 'qualifizierte', 'qualifizierten', 'moderne', 'innovative', 'hochwertige', 'kompetenten', 'professionell',
  'beratung', 'privatpersonen', 'unternehmer', 'mandanten', 'erfahrung', 'zufriedene', 'zufriedenen'];

function words(t) {
  // "3.000" / "7.000" stay one number (a unit count is a real company detail)
  return String(t || '').toLowerCase().replace(/(\d)\.(?=\d{3}\b)/g, '$1').replace(/[^\p{L}\p{N}\s-]/gu, ' ').split(/\s+/).filter(Boolean);
}

/** First sentence of email 1 after the salutation, from the "E-Mail 1 … Betreff … body" text the checker saw. */
function openingSentence(sequenceText) {
  const m = String(sequenceText || '').match(/E-Mail 1\s*\n(?:Betreff:[^\n]*\n)?([\s\S]*?)(?:\n\s*E-Mail 2|$)/);
  // the first sentence never runs past the first paragraph
  const body = (m ? m[1] : '').replace(/^\s*(Guten Tag|Sehr geehrte[rs]?|Hallo|Liebe[rs]?)[^\n,]*,?\s*/i, '').trim().split(/\n\s*\n/)[0];
  // a sentence ends at . ? ! – but not after an abbreviation ("Mr. Cleaner", "Dr. Weber", "z. B.", "ca.", "bzw."; live: Mr. Cleaner).
  // Only single letters and known abbreviations: "… bietet Reinigung an." IS a sentence end.
  const re = /[.?!–](?=\s|$)/g;
  let m2;
  while ((m2 = re.exec(body))) {
    const before = body.slice(0, m2.index + 1);
    if (m2[0] === '.' && /(^|[\s(])([A-Za-zÄÖÜäöüß]|Mr|Mrs|Ms|Dr|Prof|Dipl|Ing|Nr|ca|bzw|usw|inkl|ggf|evtl|vgl|Str|St|Hr|Fr|Tel|etc|ff|Mio|Mrd|Jh|gem|zzgl|max|min)\.$/.test(before)) continue;
    return before + ' ';
  }
  return body;
}

/**
 * The opening counts as specific only if the quoted detail (opening_detail) really appears in the company
 * description AND in the first sentence, and contains at least one distinctive word (not "Berlin", "Reinigung"…).
 * Live negative control: the model said "Unternehmen wie Ihres profitieren…" was specific – this check says no.
 */
/** The words of a quoted detail that really distinguish this company: not the campaign's industry or city, not generic. */
function distinctiveWords(detail, ctx) {
  // the campaign's own industry and city are never a distinctive detail ("Sie sind Steuerberater in Hamburg")
  const campaignWords = words(((ctx && ctx.generic) || []).join(' ')).flatMap((g) => [g, ...g.split('-')]);
  const stem = (x) => x.slice(0, 8); // "steuerberater" ~ "steuerberatung", "reinigungsunternehmen" ~ "reinigungsfirma"
  const isGeneric = (w) => GENERIC_DETAIL_WORDS.includes(w) || campaignWords.some((g) => g.length >= 4 && (w === g || stem(w) === stem(g)));
  // a founding year or a count ("1996", "3000") is specific; short numbers ("15 Minuten") are not
  return words(detail).filter((w) => (/^\d+$/.test(w) ? w.length >= 3 : w.length >= 5) && !isGeneric(w));
}

/** A detail that would count as a specific opening: distinctive and really in the company description. */
function usableDetail(detail, ctx) {
  const summary = ' ' + words(ctx && ctx.summary).join(' ') + ' ';
  const distinctive = distinctiveWords(detail, ctx);
  return distinctive.length > 0 && distinctive.every((w) => summary.includes(' ' + w + ' ') || summary.includes(w));
}

/** Numbers with 3+ digits in the description (a founding year, a count): each is a real, checkable detail. */
function summaryNumbers(summary) {
  return words(summary).filter((w) => /^\d{3,}$/.test(w));
}

/**
 * The detail that makes the opening specific, verified in code ('' if none).
 * Live (Mr. Cleaner): the opening said "Seit 2006 bietet Mr. Cleaner …", but the checker quoted "professionelle
 * Reinigungsdienstleistungen" – generic – so a good opening scored 55. Code therefore checks every real detail itself:
 * the checker's quote, the writer's own chosen details and every number from the description.
 */
function openingDetail(d, ctx) {
  const q = d || {};
  const opening = ' ' + words(openingSentence(ctx.sequence)).join(' ') + ' ';
  const has = (w) => (/^\d+$/.test(w) ? opening.includes(' ' + w + ' ') : opening.includes(w));
  // the checker's quote: one distinctive word in the opening is enough (it said where to look)
  if (q.opening_specific === true && words(q.opening_detail).length && usableDetail(q.opening_detail, ctx) &&
    distinctiveWords(q.opening_detail, ctx).some(has)) return String(q.opening_detail);
  // any other real detail: a number, or at least 2 of its distinctive words (all, if it has only one)
  const candidates = [...(Array.isArray(ctx.details) ? ctx.details : []), ...summaryNumbers(ctx.summary)];
  return candidates.find((c) => {
    if (!String(c || '').trim() || !usableDetail(c, ctx)) return false;
    const dw = distinctiveWords(c, ctx);
    const hits = dw.filter(has);
    return hits.some((w) => /^\d+$/.test(w)) || hits.length >= Math.min(2, dw.length);
  }) || '';
}

function verifiedOpening(d, ctx) {
  if (!ctx) return !!d && d.opening_specific === true;
  return !!openingDetail(d, ctx);
}

/* ------------------------------------------------------------ rewrite feedback
 * The rewrite used to get the checker's own "issues", which were empty in every low-scoring live case
 * ("Probleme: . Hinweis: ."), so the second version failed the same way. Code now says exactly what failed. */

const FILLER_FIX = [
  [/synergie/i, 'ersetze "Synergien besprechen" durch eine schlichte Frage, z. B. "ob das für Sie passt"'],
  [/kernkompetenz/i, 'ersetze "Kernkompetenzen" durch das Konkrete, z. B. "Ihr Tagesgeschäft" oder die genannte Leistung'],
  [/umfassend/i, 'streiche "umfassend" und nenne stattdessen eine konkrete Leistung aus der Beschreibung'],
  [/beeindruckend|exzellent|revolutionär/i, 'kein Lob: nenne das Detail sachlich ohne Bewertung'],
  [/Branche/i, 'statt "in Ihrer Branche" die konkrete Kundengruppe oder Leistung nennen'],
  [/wie\s+(Ihr|Sie)/i, 'statt "Firmen wie Ihre" den Namen der Firma nennen'],
];

/** Validation errors → concrete German fix instructions (one per error, duplicates removed). */
function fixHints(errors) {
  const out = (errors || []).map((e) => {
    const m = String(e).match(/^step (\d)/);
    const n = m ? 'E-Mail ' + m[1] : 'Die Antwort';
    let x;
    if ((x = e.match(/filler phrase "([^"]+)"/))) {
      const fix = (FILLER_FIX.find(([re]) => re.test(x[1])) || [null, 'formuliere den Satz sachlich und konkret'])[1];
      return n + ': "' + x[1] + '" ist verboten – ' + fix + '.';
    }
    if ((x = e.match(/body has (\d+) words/))) return n + ' hat ' + x[1] + ' Wörter (Grenze 89): kürze auf höchstens 75 Wörter, vor allem den Nutzen-Satz.';
    if ((x = e.match(/follow-up has (\d+) words \(max (\d+)\)/))) return n + ' hat ' + x[1] + ' Wörter: kürze auf höchstens ' + (Number(x[2]) - 10) + ' Wörter.';
    if (/no question/.test(e)) return n + ': der letzte Absatz muss mit genau einer Frage enden, z. B. "Passt Ihnen ein kurzes Telefonat von 15 Minuten?"';
    if (/one block of text/.test(e)) return n + ': gliedere den Text in 3 kurze Absätze mit je einer Leerzeile.';
    if ((x = e.match(/subject(_alt)? has (\d+) words/))) return n + ': ' + (x[1] ? 'subject_alt' : 'der Betreff') + ' hat ' + x[2] + ' Wörter, höchstens 5.';
    if (/exclamation/.test(e)) return n + ': keine Ausrufezeichen.';
    if (/informal/.test(e)) return n + ': durchgehend Sie-Form.';
    if (/placeholder/.test(e)) return n + ': keine Platzhalter, nur echte Angaben.';
    return n + ': ' + e;
  });
  return out.filter((x, i) => out.indexOf(x) === i);
}

/**
 * Quality answers (+ ctx {summary, sequence, generic, details}) → what exactly to fix in the rewrite.
 * details: the AI's own chosen details; only those that would really count are offered for the opening.
 */
function qualityFeedback(d, ctx) {
  const q = d || {};
  const c = ctx || {};
  const out = [];
  if (!verifiedOpening(q, c)) {
    const weak = String(q.opening_detail || '').trim();
    const why = weak && !usableDetail(weak, c) ? ' "' + weak + '" zählt nicht: Ort, Stadtteil, Branche oder allgemeine Leistungen passen auf jede Firma dort.' : '';
    const good = (c.details || []).filter((x) => usableDetail(x, c)).slice(0, 3);
    out.push('Der erste Satz von E-Mail 1 nennt kein Detail, das nur auf diese Firma passt.' + why +
      (good.length ? ' Beginne mit einem dieser Details aus der Beschreibung: ' + good.map((x) => '"' + x + '"').join(', ') + '.'
        : ' Nutze eine Zahl, ein Gründungsjahr, eine Spezialisierung oder Kundengruppe wörtlich aus der Firmenbeschreibung.'));
  }
  if (Array.isArray(q.invented_claims) && q.invented_claims.length) out.push('Streiche diese Aussagen, sie stehen nicht in der Beschreibung: ' + q.invented_claims.map((x) => '"' + x + '"').join(', ') + '.');
  const withDetail = new Set((q.emails_with_company_detail || []).map(Number));
  const missing = [1, 2, 3, 4].filter((n) => !withDetail.has(n));
  if (missing.length) out.push('E-Mail ' + missing.join(', ') + ' ' + (missing.length > 1 ? 'enthalten' : 'enthält') + ' kein Detail der Firma: bringe in jede E-Mail ein anderes Detail aus der Beschreibung.');
  if (Array.isArray(q.filler_phrases) && q.filler_phrases.length) out.push('Streiche diese Floskeln: ' + q.filler_phrases.map((x) => '"' + x + '"').join(', ') + '.');
  (q.issues || []).filter((x) => String(x || '').trim()).forEach((x) => out.push(String(x).trim()));
  if (String(q.rewrite_hint || '').trim()) out.push(String(q.rewrite_hint).trim());
  return out;
}

/** The rewrite instruction for the email prompt's retry_note. */
function rewriteNote(problems, score) {
  return '\nDie vorige Version wurde abgelehnt' + (score !== undefined && score !== null ? ' (Qualität ' + score + '/100, nötig 80)' : '') +
    '. Schreibe die Sequenz neu und behebe genau diese Punkte:\n' + (problems || []).map((x) => '- ' + x).join('\n') + '\nAlle anderen Regeln gelten weiter.';
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
  return Object.assign({}, data, { emails: data.emails.map((e) => Object.assign({}, e, { body: ve.ensureFrame(String(e.body || '').replace(/\\n/g, '\n'), Object.assign({ paragraphs: true }, opts || {})) })) });
}

function validateByPrompt(promptId, data, opts, ve) {
  const fn = VALIDATORS[promptId];
  if (!fn) return { ok: false, errors: ['unknown prompt id ' + promptId] };
  const errors = fn(data, opts || {}, ve);
  return { ok: errors.length === 0, errors };
}

const validatorsApi = { REPLY_CATEGORIES, prepareByPrompt, validateByPrompt, VALIDATORS, qualityScore, verifiedOpening, openingDetail, openingSentence, usableDetail, fixHints, qualityFeedback, rewriteNote };
if (typeof module !== 'undefined' && module.exports) module.exports = validatorsApi;
