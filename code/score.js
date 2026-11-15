/**
 * score.js – lead score 0–100 (PLAN.md Module 3):
 * director name 30 + personal email 20 + MX ok 15 + rating ≥ 4.0 10 + 20+ reviews 10 + hiring signal 15.
 * Status: Enriched if score ≥ 50 and an email exists, else Rejected with a reason.
 */
const RULES = { director: 30, personalEmail: 20, mx: 15, rating: 10, reviews: 10, hiring: 15 };
const MIN_SCORE = 50;
const GENERIC = ['info', 'kontakt', 'contact', 'office', 'mail', 'post', 'service', 'hallo', 'hello', 'buero', 'team', 'anfrage', 'empfang', 'verwaltung', 'zentrale'];

/** Personal = the local part names a person (not info@, kontakt@ …). */
function isPersonalEmail(email) {
  if (!email || !String(email).includes('@')) return false;
  const local = String(email).split('@')[0].toLowerCase();
  if (GENERIC.includes(local)) return false;
  return /^[a-zäöüß][a-zäöüß.\-_]*$/.test(local);
}

function scoreLead(lead) {
  lead = lead || {};
  const b = {
    director: lead.contact_name ? RULES.director : 0,
    personalEmail: lead.email && isPersonalEmail(lead.email) ? RULES.personalEmail : 0,
    mx: lead.mx_ok === true ? RULES.mx : 0,
    rating: typeof lead.google_rating === 'number' && lead.google_rating >= 4.0 ? RULES.rating : 0,
    reviews: Number(lead.review_count) >= 20 ? RULES.reviews : 0,
    hiring: lead.hiring_signal === true ? RULES.hiring : 0,
  };
  const score = Object.values(b).reduce((a, v) => a + v, 0);
  return { score, breakdown: b };
}

function decideStatus(lead, score) {
  if (!lead || !lead.email) return { status: 'Rejected', reason: 'no email found in Impressum' };
  if (lead.mx_ok === false) return { status: 'Rejected', reason: 'email domain has no MX record' };
  if (score < MIN_SCORE) return { status: 'Rejected', reason: `score ${score} below ${MIN_SCORE}` };
  return { status: 'Enriched', reason: '' };
}

/**
 * One person gets one sequence. Two leads are the same contact if they share the email address, or the same
 * director name together with the same address or phone (live case: one owner, two brand websites, same address).
 * The later one is Rejected as a duplicate. Name alone never counts (two different "Thomas Müller" can exist).
 * updates: [{id, fields:{email,contact_name,status,...}, company_name, address, phone}]
 * known:   [{id, email, contact_name, address, phone, company_name}] (other, non-rejected leads)
 */
function normPhone(p) {
  const d = String(p || '').replace(/\D/g, '').replace(/^49/, '0').replace(/^00/, '0');
  return d.length >= 6 ? d : '';
}

function contactKeys(x) {
  const keys = [];
  const email = String(x.email || '').trim().toLowerCase();
  if (email) keys.push('e:' + email);
  const name = String(x.contact_name || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (name) {
    const addr = String(x.address || '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (addr) keys.push('na:' + name + '|' + addr);
    const ph = normPhone(x.phone);
    if (ph) keys.push('np:' + name + '|' + ph);
  }
  return keys;
}

function markDuplicateContacts(updates, known) {
  const seen = {};
  const remember = (x) => contactKeys(x).forEach((k) => { if (!seen[k]) seen[k] = x; });
  (known || []).forEach(remember);
  return (updates || []).map((u) => {
    const f = u.fields || {};
    if (f.status === 'Rejected') return u;
    const me = { id: u.id, email: f.email, contact_name: f.contact_name, address: u.address || f.address, phone: u.phone || f.phone, company_name: u.company_name || f.company_name };
    const hit = contactKeys(me).map((k) => seen[k]).find((x) => x && x.id !== u.id);
    if (hit) {
      // remember this lead's keys too, pointing at the first one: P2 = P1 (address) and P3 = P2 (phone) → P3 = P1
      contactKeys(me).forEach((k) => { if (!seen[k]) seen[k] = hit; });
      return Object.assign({}, u, { fields: Object.assign({}, f, { status: 'Rejected', reject_reason: 'duplicate contact: same person as ' + (hit.company_name || hit.id) }) });
    }
    remember(me);
    return u;
  });
}

/** @deprecated kept for callers that only know emails */
function markDuplicateEmails(updates, known) {
  return markDuplicateContacts(updates, known);
}

const scoreApi = { markDuplicateContacts, markDuplicateEmails, contactKeys, RULES, MIN_SCORE, isPersonalEmail, scoreLead, decideStatus };
if (typeof module !== 'undefined' && module.exports) module.exports = scoreApi;
