/**
 * campaignFit.js – does a campaign fit its client?
 * Live finding: Real Service GmbH (cleaning, Berlin only) ran campaigns for tax advisers in München and for cleaning
 * companies in Frankfurt. The emails then offer a service the client cannot deliver there, or write to competitors,
 * and no amount of rewriting makes them good. These checks warn before anyone launches such a campaign.
 * Warnings never block: the person decides (e.g. a client may really be expanding to a new city).
 */

const CITY_ALIASES = {
  munich: 'münchen', muenchen: 'münchen', cologne: 'köln', koeln: 'köln', nuremberg: 'nürnberg', nuernberg: 'nürnberg',
  hanover: 'hannover', 'frankfurt am main': 'frankfurt', 'frankfurt (main)': 'frankfurt', 'frankfurt/main': 'frankfurt',
  dusseldorf: 'düsseldorf', duesseldorf: 'düsseldorf', brunswick: 'braunschweig',
};
// an area meaning "everywhere": no city check
const NATIONWIDE = /^(bundesweit|deutschlandweit|deutschland|germany|dach|überall|ganz deutschland|remote)$/i;
// generic parts of an industry name: "Reinigungsunternehmen" and "Gebäudereinigung" share the core "reinigung"
const INDUSTRY_SUFFIX = /(unternehmen|firmen|firma|betriebe?|dienste?|dienstleistungen|dienstleister|service|services|gmbh|agenturen|agentur|büros?|kanzleien|kanzlei)$/;

const GENERIC_CORES = ['management', 'consulting', 'solution', 'solutions', 'technik', 'group', 'partner', 'handel'];

function normCity(s) {
  const t = String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (CITY_ALIASES[t]) return CITY_ALIASES[t];
  const first = t.split(/[,(/-]/)[0].trim(); // "München-Laim" → "münchen", "Frankfurt (Main)" → "frankfurt"
  return CITY_ALIASES[first] || first.replace(/ am main$/, '');
}

function areas(client) {
  return String((client && client.service_area) || '').split(/[,;/\n]+|\bund\b/).map((x) => x.trim()).filter(Boolean);
}

/** The core word stems of an industry: "Reinigungsunternehmen" → ["reinigung"], "Gebäudereinigung" → ["gebäudereinigung"]. */
function cores(industry) {
  return String(industry || '').toLowerCase().split(/[^a-zäöüß]+/).filter((w) => w.length >= 5)
    .map((w) => w.replace(INDUSTRY_SUFFIX, '').replace(/s$/, ''))
    .filter((w) => w.length >= 5 && !GENERIC_CORES.includes(w));
}

function sameIndustry(a, b) {
  const x = cores(a);
  const y = cores(b);
  // "reinigung" ⊂ "gebäudereinigung"; "steuerberater" ~ "steuerberatung" (same first 8 letters)
  return x.some((p) => y.some((q) => p.includes(q) || q.includes(p) || (p.length >= 8 && q.length >= 8 && p.slice(0, 8) === q.slice(0, 8))));
}

/** c: campaign {city, industry}; client: {name, service_area, industry} → German warnings (empty when it fits). */
function campaignFit(c, client) {
  const k = client || {};
  const camp = c || {};
  const out = [];
  const list = areas(k);
  if (camp.city && list.length && !list.some((a) => NATIONWIDE.test(a))) {
    const city = normCity(camp.city);
    const fits = list.some((a) => { const n = normCity(a); return n && (city.includes(n) || n.includes(city)); });
    if (!fits) out.push(`Die Stadt "${camp.city}" liegt nicht im Einsatzgebiet von ${k.name || 'diesem Client'} (${list.join(', ')}). Die E-Mails bieten dann etwas an, das der Client dort nicht liefert.`);
  }
  if (camp.industry && k.industry && sameIndustry(camp.industry, k.industry)) {
    out.push(`Die Branche "${camp.industry}" ist die eigene Branche von ${k.name || 'diesem Client'} (${k.industry}): Sie würden Wettbewerber anschreiben.`);
  }
  return out;
}

const campaignFitApi = { campaignFit, normCity, sameIndustry, cores };
if (typeof module !== 'undefined' && module.exports) module.exports = campaignFitApi;
