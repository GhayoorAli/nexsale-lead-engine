/**
 * contacts.js – Module 3: the right decision-maker and a concrete trigger from the company's own public pages.
 *
 * Nexsale's own advice: write to the person who decides (Hausverwaltung → Objektbetreuung, Hotel → Hausdame, Praxis →
 * Praxisleitung) and use a concrete trigger per recipient. The AI lists people and a trigger from the homepage, the
 * team/contact page and the jobs page; this module only ACCEPTS what is verifiably on those pages (no invented names,
 * emails or triggers) and picks the contact whose role matches the campaign's target role. Fallback: the Impressum person.
 */
const TEAM_RE = /(team|ueber-uns|uber-uns|über-uns|about|ansprechpartner|kontakt|contact|wir-sind|unternehmen|mitarbeiter)/i;
const JOBS_RE = /(karriere|jobs?|stellen|career|bewerb)/i;

function sameSiteHref(href, domain) {
  const h = String(href || '').trim();
  if (!h || /^(mailto:|tel:|javascript:|#)/i.test(h)) return null;
  const m = h.match(/^https?:\/\/([^/]+)(\/[^#?]*)?/i);
  if (m) {
    const host = m[1].toLowerCase().replace(/^www\./, '');
    if (host !== String(domain || '').toLowerCase().replace(/^www\./, '')) return null;
    return m[2] || '/';
  }
  return h.startsWith('/') ? h.split(/[#?]/)[0] : '/' + h.split(/[#?]/)[0];
}

/** Team/contact and jobs page paths from the homepage links (same site only). Fallbacks: /kontakt and /karriere. */
function findPageLinks(html, domain) {
  const links = [];
  const re = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(String(html || ''))) !== null) {
    const path = sameSiteHref(m[1], domain);
    if (path && path !== '/') links.push({ path, text: m[2].replace(/<[^>]+>/g, ' ').trim() });
  }
  const pick = (rx, avoid) => {
    const hit = links.find((l) => rx.test(l.path) && !(avoid && avoid.test(l.path))) || links.find((l) => rx.test(l.text) && !(avoid && avoid.test(l.path)));
    return hit ? hit.path : null;
  };
  return { team: pick(TEAM_RE, /impressum|datenschutz|privacy|imprint/i) || '/kontakt', jobs: pick(JOBS_RE) || '/karriere' };
}

function norm(s) {
  return String(s || '').toLowerCase().normalize('NFKC').replace(/\s+/g, ' ').trim();
}

/** "Objektbetreuung, Hausverwalter; Geschäftsführer" → ['objektbetreuung', 'hausverwalter', 'geschäftsführer'] */
function targetRoleList(targetRole) {
  return String(targetRole || '').split(/[,;/|]|\bund\b|\boder\b/i).map(norm).filter((x) => x.length >= 3);
}

/** Rank of the best matching target role (0 = first wish), -1 if none. Matches by word stem (first 6 letters). */
function roleRank(role, targets) {
  const r = norm(role);
  if (!r) return -1;
  const words = r.split(/[^a-zäöüß]+/).filter((w) => w.length >= 4);
  for (let i = 0; i < targets.length; i++) {
    const tw = targets[i].split(/[^a-zäöüß]+/).filter((w) => w.length >= 4);
    if (tw.some((t) => words.some((w) => w.slice(0, 6) === t.slice(0, 6)))) return i;
  }
  return -1;
}

const SAL_RE = /^(herr|frau)$/i;

/** A name counts only if every part of it is on the page; an email only if it is on the page and on a related domain. */
function verifiedContact(c, pageText, domain, companyName, relatedDomain) {
  if (!c || typeof c !== 'object') return null;
  const name = String(c.name || '').replace(/\b(herr|frau|hr\.|fr\.)\s+/gi, '').trim();
  const parts = name.split(/\s+/).filter(Boolean);
  const text = norm(pageText);
  if (parts.length < 2 || parts.some((p) => p.length < 2 || !text.includes(norm(p)))) return null;
  let email = String(c.email || '').trim().toLowerCase();
  if (email && (!text.includes(email) || !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(email))) email = '';
  if (email && relatedDomain && !relatedDomain(email.split('@')[1], domain, companyName)) email = '';
  // Herr/Frau only when the page itself says so next to the name (never guessed from the first name)
  let sal = '';
  const s0 = String(c.salutation || '').trim();
  if (SAL_RE.test(s0)) {
    const S = s0.charAt(0).toUpperCase() + s0.slice(1).toLowerCase();
    if (text.includes(norm(S + ' ' + parts[parts.length - 1])) || text.includes(norm(S + ' ' + name))) sal = S;
  }
  return { name, role: String(c.role || '').trim(), email, salutation: sal };
}

/**
 * opts: { contacts (AI), targetRole, pageText, domain, companyName, impressum: {contact_name, contact_role, contact_salutation, email}, relatedDomain }
 * returns { contact_name, contact_role, contact_salutation, email, contact_source }
 */
function pickContact(opts) {
  const o = opts || {};
  const imp = o.impressum || {};
  const targets = targetRoleList(o.targetRole);
  const fallback = { contact_name: imp.contact_name || null, contact_role: imp.contact_role || null, contact_salutation: imp.contact_salutation || null,
    email: imp.email || null, contact_source: imp.contact_name ? 'Impressum' : null };
  const verified = (Array.isArray(o.contacts) ? o.contacts : []).map((c) => verifiedContact(c, o.pageText, o.domain, o.companyName, o.relatedDomain)).filter(Boolean);
  const ranked = verified.map((c) => ({ c, rank: roleRank(c.role, targets) })).filter((x) => x.rank >= 0)
    .sort((a, b) => a.rank - b.rank || (b.c.email ? 1 : 0) - (a.c.email ? 1 : 0));
  if (!ranked.length) return fallback;
  // the Impressum person already has the best matching role → keep the Impressum data (often the better email)
  const impRank = roleRank(imp.contact_role, targets);
  if (imp.contact_name && impRank >= 0 && impRank <= ranked[0].rank) return fallback;
  const best = ranked[0].c;
  return { contact_name: best.name, contact_role: best.role, contact_salutation: best.salutation || null,
    email: best.email || imp.email || null, contact_source: 'Website (Team/Kontakt)' };
}

/** A trigger counts only if its content words are on the pages (at least 2 and 70 % of the words with 6+ letters). */
function verifiedTrigger(trigger, pageText) {
  const t = String(trigger || '').trim();
  if (!t || /^(kein|keiner|none|null|-)/i.test(t)) return '';
  const text = norm(pageText);
  const words = norm(t).split(/[^a-zäöüß0-9]+/).filter((w) => w.length >= 6);
  if (words.length < 2) return '';
  const found = words.filter((w) => text.includes(w)).length;
  return found >= 2 && found / words.length >= 0.7 ? t.slice(0, 300) : '';
}

const contactsApi = { findPageLinks, targetRoleList, roleRank, verifiedContact, pickContact, verifiedTrigger, sameSiteHref };
if (typeof module !== 'undefined' && module.exports) module.exports = contactsApi;
