/**
 * parseImpressum.js – extracts contact data from a German/Austrian/Swiss Impressum page.
 * Pure regex, no AI. Returns empty fields (never throws) when nothing is found.
 */
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß', eacute: 'é', copy: '©', middot: '·', ndash: '–', mdash: '—' };

function decodeEntities(s) {
  return String(s)
    .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&([a-zA-Z]+);/g, (m, n) => (ENTITIES[n] !== undefined ? ENTITIES[n] : m));
}

function stripHtml(html) {
  if (!html) return '';
  let s = String(html);
  s = s.replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  // keep mailto addresses visible even if the link text is an image or "E-Mail"
  s = s.replace(/<a[^>]+href=["']mailto:([^"'?]+)[^"']*["'][^>]*>/gi, ' $1 ');
  s = s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h[1-6]|tr|td|section|article|address)>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  s = s.replace(/[ \t ]+/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/\n{2,}/g, '\n');
  return s.trim();
}

function deobfuscate(text) {
  return String(text)
    .replace(/\s*(\[|\(|\{)\s*(at|ät|@)\s*(\]|\)|\})\s*/gi, '@')
    .replace(/\s+(at|ät)\s+(?=[a-z0-9-]+\s*(\[|\(|\{)?\s*(dot|punkt|\.)\s*(\]|\)|\})?\s*[a-z]{2,})/gi, '@')
    .replace(/\s*(\[|\(|\{)\s*(dot|punkt)\s*(\]|\)|\})\s*/gi, '.')
    .replace(/(@[a-z0-9-]+)\s+(dot|punkt)\s+([a-z]{2,})/gi, '$1.$3');
}

const EMAIL_RE = /[a-z0-9][a-z0-9._%+-]*@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi;
const GENERIC_LOCALS = ['info', 'kontakt', 'contact', 'office', 'mail', 'post', 'service', 'hallo', 'hello', 'buero', 'büro', 'team', 'anfrage', 'empfang', 'verwaltung', 'zentrale'];
const BAD_LOCALS = ['datenschutz', 'privacy', 'noreply', 'no-reply', 'webmaster', 'abuse', 'postmaster', 'jobs', 'karriere', 'bewerbung', 'buchhaltung', 'rechnung', 'invoice'];

function extractEmails(text) {
  const found = (deobfuscate(text).match(EMAIL_RE) || []).map((e) => e.toLowerCase().replace(/\.$/, ''));
  return Array.from(new Set(found)).filter((e) => !/\.(png|jpe?g|gif|svg|webp)$/.test(e));
}

function sameDomain(email, domain) {
  if (!domain) return true;
  const d = String(email.split('@')[1] || '').toLowerCase();
  const base = String(domain).toLowerCase().replace(/^www\./, '');
  return d === base || d.endsWith('.' + base) || base.endsWith('.' + d);
}

const FREE_MAIL = ['gmail.com', 'googlemail.com', 'gmx.de', 'gmx.net', 'web.de', 't-online.de', 'yahoo.com', 'yahoo.de', 'outlook.com', 'outlook.de', 'hotmail.com', 'hotmail.de', 'icloud.com', 'freenet.de', 'posteo.de', 'aol.com', 'mail.de'];
const GENERIC_TOKENS = ['berlin', 'hamburg', 'muenchen', 'service', 'services', 'reinigung', 'gebaeudereinigung', 'cleaning', 'clean', 'group', 'gmbh', 'facility', 'online', 'germany', 'deutschland', 'team', 'office', 'shop', 'home', 'pro', 'profi', 'profis'];

function sld(domain) {
  const parts = String(domain || '').toLowerCase().replace(/^www\./, '').split('.');
  return parts.length >= 2 ? parts[parts.length - 2] : parts[0] || '';
}

function translit(s) {
  return String(s || '').toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss');
}

/**
 * True if the email domain clearly belongs to the same company as the website, e.g.
 * falconcleaning.de ↔ falcon-cleaning.de, dreimann-service.de ↔ dreimann-group.com.
 * Free-mail and unrelated domains (web agencies) never count.
 */
function relatedDomain(emailDomain, siteDomain, companyName) {
  const ed = String(emailDomain || '').toLowerCase();
  if (!ed || FREE_MAIL.includes(ed) || !siteDomain) return false;
  const a = sld(ed);
  const b = sld(siteDomain);
  if (a.replace(/-/g, '') === b.replace(/-/g, '')) return true;
  const strong = (x) => x.length >= 5 && !GENERIC_TOKENS.includes(x);
  const ta = a.split('-').filter(strong);
  const tb = b.split('-').filter(strong);
  if (ta.some((t) => tb.includes(t))) return true;
  const name = translit(companyName).replace(/[^a-z0-9]+/g, ' ');
  return ta.some((t) => new RegExp('\\b' + t + '\\b').test(name));
}

// template placeholders and tracking services are never a company's address
const JUNK_DOMAINS = /(^|\.)(example\.(com|org|net|de)|beispiel\.(de|com)|deinunternehmen\.\w+|ihre-?domain\.\w+|musterfirma\.\w+|domain\.(de|com)|sentry(-next)?\.\w+|sentry\.io|wixpress\.com)$/i;

/**
 * Small firms often publish a free-mail address as their official contact (live: glanzmarvinreinigung@gmail.com,
 * sabani.kenan@hotmail.com). It counts only when its local part clearly belongs to the company or the owner
 * (a 4+ letter token of the company name, website or contact name) – never template addresses like business@gmx.de.
 */
function companyFreeMail(email, domain, companyName, contactName) {
  const [local, dom] = String(email || '').toLowerCase().split('@');
  if (!FREE_MAIL.includes(dom)) return false;
  const l = translit(local).replace(/[^a-z0-9]/g, '');
  const tokens = [companyName, sld(domain), contactName].map((x) => translit(x).split(/[^a-z0-9]+/)).flat()
    .filter((t) => t.length >= 4 && !GENERIC_TOKENS.includes(t) && !['reinigungsservice', 'dienstleistungen', 'reinigungsfirma'].includes(t));
  return tokens.some((t) => l.includes(t));
}

/** Prefer the company's own domain, then a clearly related company domain, then the company's own free-mail address;
 *  personal over generic, info@ last. */
function pickEmail(emails, domain, companyName, contactName) {
  emails = (emails || []).filter((e) => !JUNK_DOMAINS.test(String(e).split('@')[1] || ''));
  const own = emails.filter((e) => sameDomain(e, domain));
  const related = own.length ? own : emails.filter((e) => relatedDomain(e.split('@')[1], domain, companyName));
  const pool = related.length ? related : emails.filter((e) => companyFreeMail(e, domain, companyName, contactName));
  const usable = pool.filter((e) => !BAD_LOCALS.includes(e.split('@')[0]));
  const personal = usable.filter((e) => !GENERIC_LOCALS.includes(e.split('@')[0]));
  if (personal.length) return personal[0];
  const nonInfo = usable.filter((e) => e.split('@')[0] !== 'info');
  if (nonInfo.length) return nonInfo[0];
  return usable[0] || null;
}

const ROLE_RE = /(Geschäftsführer(?:in)?|Geschäftsführung|Geschäftsführende[rn]?\s+Gesellschafter(?:in)?|Inhaber(?:in)?|Vertreten\s+durch|Vertretungsberechtigte[rn]?(?:\s+(?:Geschäftsführer(?:in)?|Person(?:en)?))?|Gesellschafter(?:in)?|Vorstand|Managing\s+Director|Owner)(?:\s*\(.*?\))?\s*[:\-–]?\s*/i;
const NAME_PART = "[A-ZÄÖÜ][a-zäöüßéèáàëïA-ZÄÖÜ'\\-]+";
const TITLE_PART = '(?:(?:Herr|Frau|Hr|Fr|Dr|Prof|Dipl|Ing|Mag|DI)\\.?(?:-[A-Za-z]+\\.?)?\\s+)*';
const NAME_RE = new RegExp('^' + TITLE_PART + '(' + NAME_PART + '(?:\\s+(?:von|van|de|zu|der|den)?\\s*' + NAME_PART + '){1,3})');
const STOP_WORDS = ['Handelsregister', 'Registergericht', 'Amtsgericht', 'Telefon', 'Tel', 'Fax', 'E-Mail', 'Email', 'Umsatzsteuer', 'USt', 'Sitz', 'Registernummer', 'Kontakt', 'Anschrift', 'Adresse', 'Straße', 'Str', 'GmbH', 'Firmenbuch', 'Steuernummer', 'Verantwortlich', 'Die', 'Der', 'Das', 'Wir', 'Und', 'Gesellschaft', 'Inhalt', 'Haftung'];

function cleanName(raw) {
  if (!raw) return null;
  const words = raw.split(/\s+/);
  const out = [];
  for (const w of words) {
    if (STOP_WORDS.includes(w.replace(/[:.,]$/, ''))) break;
    out.push(w.replace(/[,;:]$/, ''));
  }
  if (out.filter((w) => /^[A-ZÄÖÜ]/.test(w)).length < 2) return null;
  // "ADVISA-Service Reinigungsfirma" is the company, not a person (live bug)
  if (out.some((w) => /(reinigung|service|firma|gmbh|dienst|gebäude|gebaeude|facility|clean|immobilien|verwaltung|agentur|consulting|management)/i.test(w))) return null;
  return out.join(' ');
}

/** "Herr"/"Frau" (+ "Dr."/"Prof.") only when the Impressum states it, or a female role form (Geschäftsführerin).
 *  Never guessed from the first name. */
function salutationOf(part, roleWord, nameCount) {
  const p = String(part || '').trim();
  const titles = (p.match(/\b(Prof\.|Dr\.)/g) || []).join(' ');
  let g = '';
  if (/^(Herr|Hr\.)\s/.test(p)) g = 'Herr';
  else if (/^(Frau|Fr\.)\s/.test(p)) g = 'Frau';
  else if (nameCount === 1 && /(führerin|haberin|schafterin)\b/i.test(roleWord || '')) g = 'Frau';
  return g ? (g + (titles ? ' ' + titles : '')) : '';
}

function extractNames(text) {
  const names = [];
  const salutations = [];
  let role = null;
  const lines = String(text).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(ROLE_RE);
    if (!m) continue;
    let rest = line.slice(m.index + m[0].length).trim();
    if (!rest && lines[i + 1]) rest = lines[i + 1].trim();
    // a role heading followed by several names separated by "," / "und" / "&"
    const parts = rest.split(/\s*(?:,|;|\bund\b|&|\/)\s*/);
    for (const part of parts) {
      const nm = part.trim().match(NAME_RE);
      if (!nm) break;
      // "Elbe Verwaltungs GmbH" is a company (general partner), not a person
      const after = part.trim().slice(nm[0].length);
      if (/\b(GmbH|UG|AG|KG|SE|mbH)\b/.test(nm[0] + ' ' + after.slice(0, 8))) continue;
      const name = cleanName(nm[1]);
      if (name && !names.includes(name)) { names.push(name); salutations.push(part); }
    }
    if (names.length && !role) role = normaliseRole(m[1]);
    if (names.length) {
      return { names, role, salutation: salutationOf(salutations[0], m[1], names.length) };
    }
  }
  return { names, role, salutation: '' };
}

function normaliseRole(r) {
  const s = String(r || '').toLowerCase();
  if (s.includes('inhaber') || s.includes('owner')) return 'Inhaber';
  if (s.includes('vorstand')) return 'Vorstand';
  if (s.includes('gesellschafter') && !s.includes('geschäftsf')) return 'Gesellschafter';
  return 'Geschäftsführer';
}

function extractRegister(text) {
  const t = String(text);
  const m = t.match(/\bHR[ ]?[AB][ ]?-?[ ]?\d{2,7}(?:[ ][A-Z]{1,2}(?![\w-]))?/);
  if (m) return m[0].replace(/\s+/g, ' ').replace(/^HR ([AB])/, 'HR$1').trim();
  const fn = t.match(/\bFN\s?\d{3,7}\s?[a-z]\b/i); // Austria Firmenbuch
  if (fn) return fn[0].replace(/\s+/g, ' ').trim();
  const che = t.match(/\bCHE-?\d{3}\.\d{3}\.\d{3}\b/); // Switzerland UID
  if (che) return che[0];
  return null;
}

const LEGAL_FORMS = [
  ['GmbH & Co. KG', /GmbH\s*&\s*Co\.?\s*KG/],
  ['gGmbH', /\bgGmbH\b/],
  ['UG (haftungsbeschränkt)', /\bUG\b/],
  ['GmbH', /\bGmbH\b/],
  ['AG', /\bAG\b/],
  ['GbR', /\bGbR\b/],
  ['e.K.', /\be\.\s?K(?:fm|fr)?\.?/],
  ['KG', /\bKG\b/],
  ['OHG', /\bOHG\b/],
  ['e.U.', /\be\.U\.?/],
  ['Einzelunternehmen', /Einzelunternehm/i],
];

function extractLegalForm(text) {
  for (const [form, re] of LEGAL_FORMS) if (re.test(text)) return form;
  return null;
}

function parseImpressum(html, domain, companyName) {
  const empty = { email: null, emails: [], contact_name: null, contact_names: [], contact_role: null, contact_salutation: null, register_number: null, legal_form: null, text_length: 0 };
  if (!html || typeof html !== 'string') return empty;
  let text;
  try {
    text = stripHtml(html);
  } catch (e) {
    return empty;
  }
  // addresses that only appear in mailto: links (live: ESJ) count too
  const mailto = (String(html).match(/mailto:([^"'?>\s]+)/gi) || []).map((m) => m.slice(7));
  const emails = Array.from(new Set(extractEmails(text).concat(extractEmails(mailto.join(' ')))));
  const { names, role, salutation } = extractNames(text);
  return {
    email: pickEmail(emails, domain, companyName, names[0]),
    emails,
    contact_name: names[0] || null,
    contact_names: names,
    contact_role: names.length ? role : null,
    contact_salutation: salutation || null,
    register_number: extractRegister(text),
    legal_form: extractLegalForm(text),
    text_length: text.length,
  };
}

/** Finds an Impressum link on the homepage. */
function findImpressumLink(html, domain) {
  const re = /<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(String(html || '')))) {
    const href = m[1];
    const label = m[2].replace(/<[^>]+>/g, '');
    if (/impressum|imprint|legal-notice/i.test(href) || /impressum|imprint/i.test(label)) {
      if (/^https?:\/\//i.test(href)) {
        const u = href.match(/^https?:\/\/([^\/?#\[\]]+)(\/[^#]*)?$/i); // no URL global in n8n
        if (!u) return null;
        return u[2] || '/';
      }
      return href.startsWith('/') ? href : '/' + href;
    }
  }
  return null;
}

const IMPRESSUM_PATHS = ['/impressum', '/impressum/', '/imprint'];

const parseImpressumApi = {
  companyFreeMail, relatedDomain, stripHtml, deobfuscate, extractEmails, pickEmail, extractNames, extractRegister, extractLegalForm, parseImpressum, findImpressumLink, IMPRESSUM_PATHS };
if (typeof module !== 'undefined' && module.exports) module.exports = parseImpressumApi;
