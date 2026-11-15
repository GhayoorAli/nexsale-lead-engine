/**
 * campaign.js – Module 1 form validation and Module 2 search planning.
 */
const DISTRICTS = {
  berlin: ['Mitte', 'Friedrichshain-Kreuzberg', 'Pankow', 'Charlottenburg-Wilmersdorf', 'Spandau', 'Steglitz-Zehlendorf',
    'Tempelhof-Schöneberg', 'Neukölln', 'Treptow-Köpenick', 'Marzahn-Hellersdorf', 'Lichtenberg', 'Reinickendorf'],
  hamburg: ['Altona', 'Bergedorf', 'Eimsbüttel', 'Hamburg-Mitte', 'Hamburg-Nord', 'Harburg', 'Wandsbek'],
  münchen: ['Altstadt-Lehel', 'Maxvorstadt', 'Schwabing', 'Sendling', 'Pasing', 'Bogenhausen', 'Giesing', 'Neuhausen'],
  wien: ['Innere Stadt', 'Leopoldstadt', 'Landstraße', 'Wieden', 'Margareten', 'Favoriten', 'Ottakring', 'Döbling'],
};

const MAX_LEADS = 500;
const PAGE = 20; // Google Places: max 20 results per page, max 3 pages (60) per search

function pick(form, keys) {
  for (const k of keys) {
    if (form[k] !== undefined && form[k] !== null && String(form[k]).trim() !== '') return String(form[k]).trim();
  }
  return '';
}

/** Accepts the n8n Form Trigger output (labels as keys) or API-style keys. */
function validateCampaignForm(form, opts) {
  form = form || {};
  const c = {
    name: pick(form, ['name', 'Campaign name', 'campaign_name']),
    client: pick(form, ['client', 'Client']),
    industry: pick(form, ['industry', 'Industry (search term)', 'Industry']),
    city: pick(form, ['city', 'City']),
    company_size: pick(form, ['company_size', 'Company size', 'Company size range']),
    target_role: pick(form, ['target_role', 'Target role']),
  };
  const maxRaw = pick(form, ['max_leads', 'Max leads']);
  // the n8n form sends an empty number field as 0 → the default (test mode: TEST_LEAD_LIMIT, else 100)
  const def = (opts && opts.defaultMax) || 100;
  const max = maxRaw === '' || Number(maxRaw) === 0 ? def : Number(maxRaw);
  const LABELS = { name: 'Kampagnenname', industry: 'Branche (Suchbegriff)', city: 'Stadt', company_size: 'Unternehmensgröße', target_role: 'Zielrolle' };
  const errors = [];
  ['name', 'industry', 'city', 'company_size', 'target_role'].forEach((k) => {
    if (!c[k]) errors.push(LABELS[k] + ' fehlt');
  });
  if (!Number.isInteger(max) || max < 1 || max > MAX_LEADS) errors.push('Max. Leads: bitte eine ganze Zahl zwischen 1 und ' + MAX_LEADS + ' eingeben (leer = ' + def + ')');
  c.max_leads = max;
  return { ok: errors.length === 0, errors, campaign: c };
}

/**
 * Plans the Google searches for "Max leads" (the form number decides, in test mode too).
 * Fetches a little more than needed (+20 %, companies without website or already known drop out), page by page:
 * one city-wide search first (up to 3 pages = 60), then district searches only while more are needed.
 * Each request carries its own page budget; paging stops as soon as that budget is used (no wasted requests).
 * Max leads 10 → 1 request; 30 → 2; 60 → 4; 100 in Berlin → 7.
 */
function buildSearchPlan(campaign, cfg, maxLeads) {
  const industry = campaign.industry;
  const city = campaign.city;
  const needed = Math.max(1, Math.min(MAX_LEADS, Number(maxLeads) || Number(campaign.max_leads) || (cfg && cfg.testLeadLimit) || 100));
  const target = needed + Math.ceil(needed * 0.2);
  const queries = [`${industry} in ${city}`].concat((DISTRICTS[String(city).toLowerCase()] || []).map((d) => `${industry} in ${d}, ${city}`));
  const requests = [];
  let rest = target;
  for (const q of queries) {
    if (rest <= 0) break;
    const pages = Math.min(3, Math.ceil(rest / PAGE));
    requests.push({ request: { textQuery: q, languageCode: 'de', regionCode: 'DE', pageSize: Math.min(PAGE, rest) }, pages });
    rest -= pages * PAGE;
  }
  return { needed, target, maxPages: 3, pageDelayMs: 2000, requests, maxRequests: requests.reduce((a, r) => a + r.pages, 0) };
}

const campaignApi = { validateCampaignForm, buildSearchPlan, DISTRICTS, MAX_LEADS };
if (typeof module !== 'undefined' && module.exports) module.exports = campaignApi;
