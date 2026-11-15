/**
 * mapPlaces.js – maps a Google Places (New) Text Search response to Leads records.
 * Skips closed businesses and places without a website, merges duplicate domains,
 * and drops places/domains that already exist in Airtable.
 */
const SOCIAL_HOSTS = ['facebook.com', 'instagram.com', 'linkedin.com', 'xing.com', 'google.com', 'goo.gl', 'yelp.com', 'wix.com'];

/** Host of a URL without "www". Plain parsing: the n8n Code sandbox has no URL global. */
function extractDomain(url) {
  if (!url || typeof url !== 'string') return null;
  const m = url.trim().match(/^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@\/?#]*@)?([^:\/?#\s]+)(?::\d+)?(?:[\/?#]|$)/i);
  if (!m) return null;
  let host = m[1].toLowerCase();
  if (/[\[\]]/.test(host)) return null;
  host = host.replace(/^www\d?\./, '').replace(/\.$/, '');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) return null;
  return host;
}

function isSocialDomain(domain) {
  return SOCIAL_HOSTS.some((h) => domain === h || domain.endsWith('.' + h));
}

/** Google names are often SEO-stuffed: "Reinigungsfirma 𝗣𝘂𝘁𝘇𝗛𝗲𝗹𝗱𝗲𝗻 Berlin | Gebäudereinigungsservice".
 *  NFKC turns the bold maths letters back into normal ones; the part after "|" is dropped. */
function cleanCompanyName(name) {
  let s = String(name || '').normalize('NFKC');
  s = s.split(/\s+[|•]\s+/)[0];
  return s.replace(/\s+/g, ' ').trim();
}

function cityFromAddress(address) {
  // "Oranienstraße 1, 10999 Berlin, Deutschland" -> "Berlin"
  const m = String(address || '').match(/\b\d{4,5}\s+([^,]+)/);
  return m ? m[1].trim() : '';
}

function mapPlace(place, ctx) {
  const domain = extractDomain(place.websiteUri);
  return {
    google_place_id: place.id,
    company_name: cleanCompanyName(place.displayName && place.displayName.text),
    google_name: (place.displayName && place.displayName.text) || '',
    domain,
    website: place.websiteUri || '',
    phone: place.nationalPhoneNumber || '',
    address: place.formattedAddress || '',
    city: cityFromAddress(place.formattedAddress) || ctx.city || '',
    google_rating: typeof place.rating === 'number' ? place.rating : null,
    review_count: typeof place.userRatingCount === 'number' ? place.userRatingCount : 0,
    google_maps_uri: place.googleMapsUri || '',
    status: 'New',
    lead_type: 'Outbound',
    source: 'Google Places API',
    sourced_at: ctx.now,
    campaign: ctx.campaignRecordId ? [ctx.campaignRecordId] : undefined,
    campaign_record_id: ctx.campaignRecordId || '',
  };
}

/**
 * @param responses array of Places responses (or a single one)
 * @param ctx {campaignRecordId, city, now, existing: {placeIds:[], domains:[]}, limit}
 * @returns {leads, skipped:[{name, reason}]}
 */
function mapPlaces(responses, ctx) {
  ctx = ctx || {};
  const list = Array.isArray(responses) ? responses : [responses];
  const existingIds = new Set(((ctx.existing && ctx.existing.placeIds) || []).filter(Boolean));
  const existingDomains = new Set(((ctx.existing && ctx.existing.domains) || []).filter(Boolean).map((d) => d.toLowerCase()));
  const seenDomains = new Set();
  const seenIds = new Set();
  const leads = [];
  const skipped = [];
  list.forEach((resp) => {
    if (resp && resp.error) throw new Error('Google Places request failed after retries: ' + (resp.error.message || JSON.stringify(resp.error)).slice(0, 200));
  });
  list.forEach((resp) => {
    ((resp && resp.places) || []).forEach((place) => {
      const name = (place.displayName && place.displayName.text) || place.id;
      if (place.businessStatus && place.businessStatus !== 'OPERATIONAL') {
        skipped.push({ name, reason: 'not operational: ' + place.businessStatus });
        return;
      }
      const domain = extractDomain(place.websiteUri);
      if (!domain) {
        skipped.push({ name, reason: 'no website' });
        return;
      }
      if (isSocialDomain(domain)) {
        skipped.push({ name, reason: 'website is a social profile' });
        return;
      }
      if (seenIds.has(place.id) || existingIds.has(place.id)) {
        skipped.push({ name, reason: 'duplicate place id' });
        return;
      }
      if (seenDomains.has(domain) || existingDomains.has(domain)) {
        skipped.push({ name, reason: 'duplicate domain ' + domain });
        return;
      }
      // limit 0 means "campaign already full" (a re-run), not "no limit"
      if (ctx.limit !== undefined && ctx.limit !== null && leads.length >= ctx.limit) {
        skipped.push({ name, reason: 'campaign limit reached' });
        return;
      }
      seenIds.add(place.id);
      seenDomains.add(domain);
      leads.push(mapPlace(place, ctx));
    });
  });
  return { leads, skipped };
}

const PLACES_FIELD_MASK =
  'places.id,places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.websiteUri,places.rating,places.userRatingCount,places.types,places.businessStatus,places.googleMapsUri,nextPageToken';

const mapPlacesApi = { cleanCompanyName, extractDomain, mapPlace, mapPlaces, cityFromAddress, isSocialDomain, PLACES_FIELD_MASK };
if (typeof module !== 'undefined' && module.exports) module.exports = mapPlacesApi;
