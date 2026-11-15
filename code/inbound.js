/**
 * inbound.js – Module 9: normalise quiz / Meta ad payloads, dedupe, task due dates.
 */
const QUIZ_QUESTIONS = [
  ['q1_industry', 'In welcher Branche ist Ihr Unternehmen tätig?'],
  ['q2_team_size', 'Wie viele Mitarbeitende hat Ihr Unternehmen?'],
  ['q3_current_acquisition', 'Wie gewinnen Sie heute Neukunden?'],
  ['q4_goal', 'Wie viele neue Termine pro Monat wünschen Sie sich?'],
  ['q5_budget', 'Welches monatliche Budget planen Sie für Vertrieb ein?'],
  ['q6_start', 'Wann möchten Sie starten?'],
];

function lc(v) {
  return String(v || '').trim().toLowerCase();
}

function normaliseInbound(payload) {
  const p = (payload && (payload.body || payload)) || {};
  const isAd = !!(p.leadgen_id || p.ad_id || p.form_id || lc(p.source) === 'meta');
  const fields = {};
  if (Array.isArray(p.field_data)) p.field_data.forEach((f) => (fields[f.name] = (f.values || [])[0]));
  const get = (...keys) => {
    for (const k of keys) if (p[k] !== undefined && p[k] !== '') return String(p[k]).trim();
    for (const k of keys) if (fields[k] !== undefined && fields[k] !== '') return String(fields[k]).trim();
    return '';
  };
  const email = lc(get('email', 'E-Mail', 'Email'));
  const website = get('website', 'Website');
  let domain = '';
  if (website) domain = lc(website).replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  else if (email.includes('@')) domain = email.split('@')[1];
  const answers = {};
  QUIZ_QUESTIONS.forEach(([k, q]) => {
    const v = get(k, q);
    if (v) answers[q] = v;
  });
  const errors = [];
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) errors.push('valid email required');
  return {
    ok: errors.length === 0,
    errors,
    lead: {
      contact_name: get('name', 'full_name', 'Name'),
      email,
      phone: get('phone', 'phone_number', 'Telefon'),
      company_name: get('company', 'company_name', 'Firma'),
      domain,
      website: website || (domain ? 'https://' + domain : ''),
      lead_type: isAd ? 'Inbound ad' : 'Inbound quiz',
      source: isAd ? 'Meta Lead Ads' : 'Website quiz (Web3Forms)',
      inbound_answers: Object.entries(answers).map(([q, a]) => `${q}: ${a}`).join('\n'),
    },
    answers,
  };
}

const FREE_MAIL = ['gmail.com', 'googlemail.com', 'gmx.de', 'gmx.net', 'web.de', 't-online.de', 'yahoo.com', 'yahoo.de', 'outlook.com', 'hotmail.com', 'icloud.com', 'freenet.de', 'posteo.de'];

function findExisting(lead, leads) {
  const email = lc(lead.email);
  const domain = lc(lead.domain);
  const byEmail = (leads || []).find((l) => lc(l.email) === email);
  if (byEmail) return { existing: byEmail, by: 'email' };
  if (domain && !FREE_MAIL.includes(domain)) {
    const byDomain = (leads || []).find((l) => lc(l.domain) === domain);
    if (byDomain) return { existing: byDomain, by: 'domain' };
  }
  return { existing: null, by: null };
}

/** Rule-based fallback if the AI is unavailable. */
function ruleTemperature(answers) {
  const text = lc(Object.values(answers || {}).join(' '));
  let pts = 0;
  if (/sofort|so schnell wie möglich|diesen monat|asap/.test(text)) pts += 2;
  if (/(\d{4,}|€\s?\d{3,}|1\.000|2\.000|5\.000)/.test(text)) pts += 1;
  if (/(10|20|\d{2,})\s*termine/.test(text)) pts += 1;
  return pts >= 3 ? 'hot' : pts >= 1 ? 'warm' : 'cold';
}

/** hot: due in 15 minutes; warm: same day 17:00 Berlin (or +2h if later); cold: next day. */
function taskDueAt(temperature, now, sched) {
  const t = new Date(now || Date.now());
  const temp = lc(temperature);
  if (temp === 'hot') return new Date(t.getTime() + 15 * 60000).toISOString();
  if (temp === 'warm') {
    const p = sched.berlinParts(t);
    const eod = sched.berlinToUtc(p.year, p.month, p.day, 17, 0);
    return (eod > t ? eod : new Date(t.getTime() + 2 * 3600000)).toISOString();
  }
  return new Date(t.getTime() + 24 * 3600000).toISOString();
}

const inboundApi = { QUIZ_QUESTIONS, normaliseInbound, findExisting, ruleTemperature, taskDueAt, FREE_MAIL };
if (typeof module !== 'undefined' && module.exports) module.exports = inboundApi;
