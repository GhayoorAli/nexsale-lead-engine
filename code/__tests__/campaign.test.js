const C = require('../campaign');

const form = { 'Campaign name': 'Cleaning companies Berlin', 'Industry (search term)': 'Reinigungsunternehmen', City: 'Berlin', 'Company size range': '10-50', 'Target role': 'Geschäftsführer', 'Max leads': '100' };

describe('validateCampaignForm', () => {
  test('accepts the n8n form output', () => {
    const r = C.validateCampaignForm(form);
    expect(r.ok).toBe(true);
    expect(r.campaign).toMatchObject({ name: 'Cleaning companies Berlin', industry: 'Reinigungsunternehmen', city: 'Berlin', max_leads: 100 });
  });
  test('max leads: the form number decides (1..500); empty or 0 → default', () => {
    const v = (m, o) => C.validateCampaignForm(Object.assign({}, form, { 'Max leads': m }), o);
    expect(v('').campaign.max_leads).toBe(100);
    expect(v('', { defaultMax: 10 }).campaign.max_leads).toBe(10); // test mode default = TEST_LEAD_LIMIT
    expect(v(0, { defaultMax: 10 }).campaign.max_leads).toBe(10); // the n8n form sends an empty number field as 0
    [1, 5, 10, 20, 37, 100, 500].forEach((n) => { expect(v(String(n)).ok).toBe(true); expect(v(String(n)).campaign.max_leads).toBe(n); });
    expect(v('501').ok).toBe(false);
    expect(v('-3').ok).toBe(false);
    expect(v('12.5').ok).toBe(false);
    expect(v('abc').ok).toBe(false);
    expect(v('501').errors[0]).toMatch(/^Max\. Leads: bitte eine ganze Zahl zwischen 1 und 500/);
  });
  test('all fields required', () => {
    const r = C.validateCampaignForm({});
    expect(r.ok).toBe(false);
    expect(r.errors).toHaveLength(5);
    expect(r.errors).toContain('Kampagnenname fehlt');
    expect(C.validateCampaignForm().ok).toBe(false);
  });
});

describe('buildSearchPlan: Max leads decides, Google is paged only as far as needed', () => {
  const camp = { industry: 'Reinigungsunternehmen', city: 'Berlin' };
  const total = (p) => p.requests.reduce((a, r) => a + r.pages, 0);
  test('10 leads → exactly 1 request (12 places incl. 20 % buffer), city-wide search', () => {
    const p = C.buildSearchPlan(camp, {}, 10);
    expect(p.requests).toEqual([{ request: { textQuery: 'Reinigungsunternehmen in Berlin', languageCode: 'de', regionCode: 'DE', pageSize: 12 }, pages: 1 }]);
    expect(p.needed).toBe(10);
    expect(total(p)).toBe(1);
  });
  test('20 → 24 places → 2 pages of one search', () => {
    const p = C.buildSearchPlan(camp, {}, 20);
    expect(p.requests).toHaveLength(1);
    expect(p.requests[0].pages).toBe(2);
    expect(p.requests[0].request.pageSize).toBe(20);
  });
  test('60 → 72 places → city-wide 3 pages + one district search with 1 page', () => {
    const p = C.buildSearchPlan(camp, {}, 60);
    expect(p.requests.map((r) => [r.request.textQuery, r.pages])).toEqual([['Reinigungsunternehmen in Berlin', 3], ['Reinigungsunternehmen in Mitte, Berlin', 1]]);
    expect(total(p)).toBe(4);
  });
  test('100 in Berlin → 120 places → 6 requests, never more than needed', () => {
    const p = C.buildSearchPlan(camp, {}, 100);
    expect(total(p)).toBe(6);
    expect(p.maxRequests).toBe(6);
    expect(p.requests.every((r) => r.pages >= 1 && r.pages <= 3)).toBe(true);
  });
  test('a city without a district list stops at Google\'s 60 per search', () => {
    const p = C.buildSearchPlan({ industry: 'x', city: 'Kleinstadt' }, {}, 200);
    expect(p.requests).toHaveLength(1);
    expect(p.requests[0].pages).toBe(3);
  });
  test('defaults: campaign max_leads, then TEST_LEAD_LIMIT, then 100; capped at 500', () => {
    expect(C.buildSearchPlan(Object.assign({ max_leads: 30 }, camp), {}).needed).toBe(30);
    expect(C.buildSearchPlan(camp, { testLeadLimit: 10 }).needed).toBe(10);
    expect(C.buildSearchPlan(camp, {}).needed).toBe(100);
    expect(C.buildSearchPlan(camp, {}, 9999).needed).toBe(500);
    expect(C.buildSearchPlan(camp, {}, 1).requests[0].request.pageSize).toBe(2);
  });
});
