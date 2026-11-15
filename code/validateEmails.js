/**
 * validateEmails.js – checks an AI-written 4-step sequence before it is stored or sent.
 * Rules (PLAN.md Module 4): 4 steps, message text < 90 words (salutation, signature and footer excluded), formal "Sie" only,
 * no placeholders, no exclamation marks, a legal footer on every final email.
 */
const MAX_WORDS = 90; // first email: under 90 words (Nexsale blog: max. 90)
const MAX_FOLLOWUP_WORDS = 50; // follow-ups: max. 50 words, one new angle (Nexsale blog)
const MAX_SUBJECT_WORDS = 5; // subject lines: max. 5 words (Nexsale blog)
const INFORMAL_RE = /\b(du|dich|dir|dein|deine|deinen|deinem|deiner|deines|euch|euer|eure|ihr seid|hast du|kannst du)\b/i;
const PLACEHOLDER_RE = /(\{\{|\}\}|\[(?:name|firma|company|vorname|nachname|placeholder)[^\]]*\]|<<|>>|\bXXX\b|\bTODO\b|lorem ipsum)/i;
const FOOTER_MARKER = 'Antworten Sie mit STOP';
// empty phrases a professional first contact never uses (checked in code; live: "Firmen wie Ihre", "Kernkompetenzen")
const FILLER_RE = /\b(?:Unternehmen|Firmen|Betriebe)\s+wie\s+(?:Ihres|Ihrer|Ihrem|Ihren|Ihre|Ihr|Sie)\b|in Ihrer Branche|zuverlässige[nrs]?\s+Partner|Kernkompetenz|messbare[n]?\s+Ergebnisse|\bumfassende?[nrs]?\b|exzellent|beeindruckend|revolutionär|Synergie|ich hoffe,? es geht Ihnen gut|Win-win/i;

function countWords(text) {
  return String(text || '')
    .trim()
    .split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

function hasInformal(text) {
  // "Sie"/"Ihnen" are fine. Lowercase "ihr" as pronoun is informal; "Ihr" (capital) is formal possessive.
  if (INFORMAL_RE.test(String(text || ''))) return true;
  return /(^|[.!?]\s+|\s)ihr\s+(habt|seid|könnt|wollt)\b/.test(String(text || ''));
}

function hasPlaceholder(text) {
  return PLACEHOLDER_RE.test(String(text || ''));
}

function stripFooter(body, footer) {
  const b = String(body || '');
  if (footer && b.includes(footer.trim())) return b.slice(0, b.indexOf(footer.trim())).trim();
  const i = b.indexOf('\n-- \n');
  return i >= 0 ? b.slice(0, i).trim() : b.trim();
}

function validateEmail(email, opts) {
  opts = opts || {};
  const errors = [];
  if (!email || typeof email !== 'object') return ['email is not an object'];
  const subject = String(email.subject || '').trim();
  const body = String(email.body || '');
  const core = stripFooter(body, opts.footer);
  const step = email.step;
  if (!subject) errors.push(`step ${step}: subject missing`);
  if (subject.length > 80) errors.push(`step ${step}: subject longer than 80 characters`);
  if (Number(step) === 1 && countWords(subject) > MAX_SUBJECT_WORDS) errors.push(`step 1: subject has ${countWords(subject)} words (max ${MAX_SUBJECT_WORDS})`);
  if (!core) errors.push(`step ${step}: body missing`);
  const words = countWords(messageText(core));
  if (words >= MAX_WORDS) errors.push(`step ${step}: body has ${words} words (max ${MAX_WORDS - 1})`);
  else if (Number(step) > 1 && words > MAX_FOLLOWUP_WORDS) errors.push(`step ${step}: follow-up has ${words} words (max ${MAX_FOLLOWUP_WORDS})`);
  if (hasInformal(subject + ' ' + core)) errors.push(`step ${step}: informal "du" form`);
  if (hasPlaceholder(subject + ' ' + body)) errors.push(`step ${step}: leftover placeholder`);
  if (/!/.test(subject + core)) errors.push(`step ${step}: exclamation mark`);
  const msg = messageText(core);
  const filler = msg.match(FILLER_RE);
  if (filler) errors.push(`step ${step}: filler phrase "${filler[0]}"`);
  // exactly one clear call to action: the last paragraph asks a question
  const lastPara = msg.split(/\n\s*\n/).filter((x) => x.trim()).slice(-1)[0] || '';
  if (msg && !lastPara.includes('?')) errors.push(`step ${step}: no question (call to action) in the last paragraph`);
  // a first email of 40+ words as one block of text is hard to read (live: CLS Clean); short messages may be one paragraph
  if (Number(step) === 1 && countWords(msg) >= 40 && msg.split(/\n\s*\n/).filter((x) => x.trim()).length < 2) errors.push('step 1: one block of text, needs at least 2 paragraphs');
  // greeting and sign-off are required (live: the model once dropped both for one lead)
  if (core && !/^(Guten Tag|Sehr geehrte[rs]?|Hallo|Liebe[rs]?|Dear|Hello)\b/i.test(core)) errors.push(`step ${step}: greeting missing`);
  if (core && !/(Viele Grüße|Beste Grüße|Freundliche Grüße|Mit freundlichen Grüßen|Best regards|Kind regards)\s*,?\s*\n?\s*\S+/i.test(core.slice(-250))) errors.push(`step ${step}: sign-off missing`);
  if (opts.senderName && core && !core.slice(-250).includes(opts.senderName)) errors.push(`step ${step}: sender name missing in sign-off`);
  if (opts.requireFooter) {
    if (!body.includes(FOOTER_MARKER) || (opts.footer && !body.includes(opts.footer.trim()))) {
      errors.push(`step ${step}: legal footer missing`);
    }
  }
  return errors;
}

function validateSequence(emails, opts) {
  opts = opts || {};
  const errors = [];
  if (!Array.isArray(emails)) return { ok: false, errors: ['sequence is not an array'] };
  if (emails.length !== 4) errors.push(`expected 4 emails, got ${emails.length}`);
  const steps = emails.map((e) => e && Number(e.step)).sort();
  if (steps.join(',') !== '1,2,3,4') errors.push('steps must be 1,2,3,4');
  emails.forEach((e) => errors.push(...validateEmail(e, opts)));
  return { ok: errors.length === 0, errors };
}

/** Builds the fixed legal footer from a Clients record: company details (Impressum duty for business email),
 *  where the contact data comes from (GDPR Art. 14) and the opt-out. */
function buildFooter(client) {
  client = client || {};
  const lines = ['-- ', client.sender_company_footer || client.sender_company || client.name || 'Nexsale GmbH'];
  lines.push('Ihre geschäftlichen Kontaktdaten stammen aus dem öffentlichen Impressum Ihrer Website.');
  lines.push('Antworten Sie mit STOP, wenn Sie keine weiteren E-Mails erhalten möchten.');
  return lines.join('\n');
}

function appendFooter(body, footer) {
  const b = String(body || '').trim();
  if (b.includes(FOOTER_MARKER)) return b;
  return b + '\n\n' + footer;
}

/** Normalises the AI output: accepts {emails:[...]} or a bare array. */
function normaliseSequence(data) {
  const list = Array.isArray(data) ? data : data && Array.isArray(data.emails) ? data.emails : null;
  if (!list) return null;
  // the model sometimes writes the two characters "\n" instead of a line break (seen live) – fix it in code
  const unescape = (t) => String(t || '').replace(/\\r\\n|\\n/g, '\n').replace(/\\t/g, ' ').replace(/[ \t]+\n/g, '\n').trim();
  return list.map((e, i) => ({
    step: Number(e.step || i + 1),
    subject: unescape(e.subject).replace(/\n+/g, ' '),
    body: unescape(e.body),
  }));
}

const GREETING_RE = /^(Guten Tag|Sehr geehrte[rs]?|Hallo|Liebe[rs]?|Dear|Hello)\b/i;
const SIGNOFF_RE = /(Viele Grüße|Beste Grüße|Freundliche Grüße|Mit freundlichen Grüßen|Best regards|Kind regards)/i;
const SIGNOFF = 'Mit freundlichen Grüßen';
const ACADEMIC = /^(Dr\.?|Prof\.?|Dipl\.?-?[A-Za-z]*\.?)$/;

function knownName(name) {
  const n = String(name || '').trim();
  return n && !/^(unbekannt|unknown|null|-)$/i.test(n) ? n : '';
}

/**
 * Formal German salutation. Gender is never guessed from a first name: "Sehr geehrter Herr …" / "Sehr geehrte Frau …"
 * only when the Impressum says Herr/Frau (contactSalutation), otherwise "Guten Tag Vorname Nachname,";
 * no contact at all → "Sehr geehrte Damen und Herren,".
 */
function salutationLine(opts) {
  opts = opts || {};
  const name = knownName(opts.contactName);
  const sal = String(opts.contactSalutation || '').trim();
  if (!name) return 'Sehr geehrte Damen und Herren,';
  const m = sal.match(/^(Herr|Frau)\b\s*(.*)$/);
  if (m) {
    const parts = name.split(/\s+/);
    const titles = (m[2] ? m[2].split(/\s+/) : []).concat(parts.filter((w) => ACADEMIC.test(w)));
    const surname = parts.filter((w) => !ACADEMIC.test(w)).slice(-1)[0];
    const t = Array.from(new Set(titles.filter(Boolean))).join(' ');
    return (m[1] === 'Herr' ? 'Sehr geehrter Herr ' : 'Sehr geehrte Frau ') + (t ? t + ' ' : '') + surname + ',';
  }
  return 'Guten Tag ' + name + ',';
}

/** Signature block from the Clients record; empty fields are left out. */
function buildSignature(client) {
  client = client || {};
  const contact = [client.sender_phone ? 'Tel. ' + client.sender_phone : '', String(client.sender_website || '').replace(/^https?:\/\//, '').replace(/\/$/, '')]
    .filter(Boolean).join(' · ');
  return [SIGNOFF, '', client.sender_name || 'Anna Berger', client.sender_title, client.sender_company, contact].filter((x) => x !== undefined && x !== null && (x === '' || String(x).trim())).join('\n').replace(/\n+$/, '');
}

/** What the sender offers, in one sentence (Clients.offer, else a neutral default without numbers or promises). */
function offerText(client, industry) {
  const o = String((client && client.offer) || '').trim();
  if (o) return o;
  const who = String(industry || '').trim() ? 'Unternehmen aus dem Bereich "' + String(industry).trim() + '"' : 'Unternehmen';
  return 'Wir übernehmen für ' + who + ' die Neukundengewinnung: passende Geschäftskunden recherchieren, persönlich per E-Mail ansprechen, '
    + 'Rückmeldungen vorqualifizieren und Ersttermine direkt in den Kalender legen.';
}

/** The message text only: without the salutation, the sign-off/signature and the footer. */
function messageText(body) {
  let b = stripFooter(body).trim();
  const lines = b.split('\n');
  // only a real salutation line ("Sehr geehrter Herr Oral,") is removed, never a sentence that starts with "Guten Tag"
  if (lines.length && GREETING_RE.test(lines[0].trim()) && /,$/.test(lines[0].trim()) && lines[0].trim().length <= 80) lines.shift();
  b = lines.join('\n').trim();
  // cut a sign-off only when it starts its own line after the message and only a short signature follows it
  const re = new RegExp('\\n[ \\t]*' + SIGNOFF_RE.source, 'gi');
  let last = null;
  let m;
  while ((m = re.exec(b)) !== null) last = m;
  if (last && b.length - last.index <= 250) b = b.slice(0, last.index).trim();
  return b;
}

/**
 * Paragraphs are formatting, so code does them (live: gpt-4o-mini often wrote email 1 as one block or with single line
 * breaks, and 5 of 12 good Hausverwaltung sequences were rejected for it). Words are never changed:
 * single line breaks become paragraph breaks; a single block of 40+ words is split into
 * [first sentence] [middle] [closing question].
 */
function formatParagraphs(text) {
  let t = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!t || /\n\s*\n/.test(t)) return t;
  if (/\n/.test(t)) return t.split(/\n+/).map((x) => x.trim()).filter(Boolean).join('\n\n');
  if (countWords(t) < 40) return t;
  // a sentence ends at . ? ! followed by a space and a capital letter or quote ("7.000" or "z. B." never split)
  const sentences = t.split(/(?<=[.!?])\s+(?=[A-ZÄÖÜ„"])/).reduce((acc, piece) => {
    // "z. B.", "ca.", "Nr.", "Dr." end with a short word + period: not a sentence end → glue the next piece back on
    if (acc.length && /(^|\s)[A-Za-zÄÖÜäöüß]{1,3}\.$/.test(acc[acc.length - 1])) acc[acc.length - 1] += ' ' + piece;
    else acc.push(piece);
    return acc;
  }, []);
  if (sentences.length < 3) return t;
  const parts = sentences.map((x) => x.trim());
  const last = /\?$/.test(parts[parts.length - 1]) ? parts.pop() : null;
  const first = parts.shift();
  return [first, parts.join(' '), last].filter((x) => x && x.trim()).join('\n\n');
}

/**
 * Salutation, sign-off and signature are fixed boilerplate, so code writes them (the same on every email) and the
 * model only writes the message. Live: the model dropped greeting/sign-off in ~3 of 10 sequences.
 */
function ensureFrame(body, opts) {
  opts = opts || {};
  const text = opts.paragraphs ? formatParagraphs(messageText(body)) : messageText(body);
  if (!text) return '';
  const signature = opts.signature || buildSignature({ sender_name: opts.senderName });
  return salutationLine(opts) + '\n\n' + text + '\n\n' + signature;
}

const validateEmailsApi = {
  formatParagraphs,
  MAX_FOLLOWUP_WORDS,
  MAX_SUBJECT_WORDS,
  FILLER_RE,
  ensureFrame,
  salutationLine,
  buildSignature,
  offerText,
  messageText,
  MAX_WORDS,
  FOOTER_MARKER,
  countWords,
  hasInformal,
  hasPlaceholder,
  validateEmail,
  validateSequence,
  buildFooter,
  appendFooter,
  normaliseSequence,
  stripFooter,
};
if (typeof module !== 'undefined' && module.exports) module.exports = validateEmailsApi;
