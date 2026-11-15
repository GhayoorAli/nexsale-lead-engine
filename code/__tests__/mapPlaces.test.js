const M = require('../mapPlaces');
const fixture = require('../../tests/fixtures/google_places_berlin_10.json');
const withSkips = require('../../tests/fixtures/google_places_with_skips.json');

const ctx = { campaignRecordId: 'recCAMP', city: 'Berlin', now: '2026-11-14T10:00:00.000Z' };

test('the saved Berlin response gives 10 leads, each with website and phone', () => {
  const { leads } = M.mapPlaces(fixture, ctx);
  expect(leads).toHaveLength(10);
  leads.forEach((l) => {
    expect(l.website).toBeTruthy();
    expect(l.phone).toBeTruthy();
    expect(l.status).toBe('New');
    expect(l.source).toBe('Google Places API');
    expect(l.sourced_at).toBe(ctx.now);
    expect(l.campaign).toEqual(['recCAMP']);
    expect(l.city).toBe('Berlin');
  });
  expect(new Set(leads.map((l) => l.domain)).size).toBe(10);
});

test('closed business is skipped and place without website is dropped', () => {
  const { leads, skipped } = M.mapPlaces(withSkips, ctx);
  expect(leads).toHaveLength(10);
  expect(skipped.map((s) => s.reason)).toEqual(['not operational: CLOSED_PERMANENTLY', 'no website']);
});

test('duplicate domains are merged (within the response and against Airtable)', () => {
  const p = (id, url) => ({ id, displayName: { text: id }, websiteUri: url, businessStatus: 'OPERATIONAL' });
  const r = M.mapPlaces([{ places: [p('a', 'https://www.firma.de/'), p('b', 'http://firma.de/kontakt'), p('c', 'https://alt.de')] }, { places: [p('a', 'https://x.de')] }], {
    existing: { domains: ['alt.de'], placeIds: [] },
  });
  expect(r.leads.map((l) => l.google_place_id)).toEqual(['a']);
  expect(r.skipped.map((s) => s.reason)).toEqual(['duplicate domain firma.de', 'duplicate domain alt.de', 'duplicate place id']);
});

test('limit 0 = campaign already full: nothing new; no limit given = all', () => {
  expect(M.mapPlaces(fixture, { limit: 0 }).leads).toHaveLength(0);
  expect(M.mapPlaces(fixture, { limit: 0 }).skipped.every((x) => /limit reached|duplicate|no website|not operational/.test(x.reason))).toBe(true);
  expect(M.mapPlaces(fixture, {}).leads.length).toBeGreaterThan(3);
});

test('existing place ids are skipped and limit is respected', () => {
  const r = M.mapPlaces(fixture, { existing: { placeIds: ['ChIJ-demo-0001'] }, limit: 3 });
  expect(r.leads).toHaveLength(3);
  expect(r.leads[0].google_place_id).toBe('ChIJ-demo-0002');
});

test.each([
  ['https://www.firma.de/impressum?x=1', 'firma.de'],
  ['http://WWW.Firma.DE', 'firma.de'],
  ['firma.de/pfad/unter', 'firma.de'],
  ['https://www2.shop.firma.de/', 'shop.firma.de'],
  ['https://firma.de./', 'firma.de'],
  ['', null],
  [null, null],
  ['http://localhost', null],
  ['http://[bad', null],
])('extractDomain(%p) = %p', (url, d) => expect(M.extractDomain(url)).toBe(d));

test('social profiles are not company websites', () => {
  const r = M.mapPlaces({ places: [{ id: 'x', displayName: { text: 'X' }, websiteUri: 'https://www.facebook.com/x', businessStatus: 'OPERATIONAL' }] }, {});
  expect(r.leads).toHaveLength(0);
  expect(r.skipped[0].reason).toMatch(/social/);
});

test('empty and odd responses', () => {
  expect(M.mapPlaces({}, {}).leads).toEqual([]);
  expect(M.mapPlaces(null).leads).toEqual([]);
  expect(M.cityFromAddress('nowhere')).toBe('');
  const l = M.mapPlace({ id: 'q', websiteUri: 'https://q.de' }, {});
  expect(l.company_name).toBe('');
  expect(l.google_rating).toBeNull();
  expect(l.review_count).toBe(0);
  expect(l.campaign).toBeUndefined();
});

test('field mask stays on the Enterprise tier (no reviews/photos)', () => {
  expect(M.PLACES_FIELD_MASK).not.toMatch(/reviews|photos|editorialSummary/);
  expect(M.PLACES_FIELD_MASK).toMatch(/nextPageToken/);
});

test('a Google error body (after retries) fails the run instead of looking like 0 results', () => {
  expect(() => M.mapPlaces([{ error: { code: 500, message: 'forced 500' } }], {})).toThrow(/after retries: forced 500/);
  expect(M.mapPlaces([{}], {}).leads).toEqual([]);
});

test('SEO-stuffed Google names are cleaned (bold unicode letters, "| tail")', () => {
  expect(M.cleanCompanyName('Reinigungsfirma \u{1D5E3}\u{1D602}\u{1D601}\u{1D607}\u{1D5DB}\u{1D5F2}\u{1D5F9}\u{1D5F1}\u{1D5F2}\u{1D5FB} Berlin | Gebäudereinigungsservice')).toBe('Reinigungsfirma PutzHelden Berlin');
  expect(M.cleanCompanyName('Falcon Cleaning')).toBe('Falcon Cleaning');
  expect(M.cleanCompanyName('A • B')).toBe('A');
  expect(M.cleanCompanyName(undefined)).toBe('');
  const l = M.mapPlace({ id: 'x', displayName: { text: 'Firma X | Beste Reinigung' }, websiteUri: 'https://x.de' }, {});
  expect(l.company_name).toBe('Firma X');
  expect(l.google_name).toBe('Firma X | Beste Reinigung');
});
