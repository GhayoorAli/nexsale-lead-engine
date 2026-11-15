const S = require('../statusPage');

const camp = (status, extra) => Object.assign({ id: 'recC', name: 'Reinigungsunternehmen Berlin', status }, extra);
const leads = (statuses) => statuses.map((status, i) => ({ id: 'L' + i, status, company_name: 'Firma ' + i, contact_name: 'Person ' + i, quality_score: 90 }));

describe('progress', () => {
  test('just created: Google search running, nothing else yet', () => {
    const p = S.progress(camp('Sourcing'), []);
    expect(p.steps.map((s) => s.state)).toEqual(['done', 'active', 'pending', 'pending', 'pending']);
    expect(p.steps[1].detail).toBe('Suche läuft …');
  });
  test('enrichment half done', () => {
    const p = S.progress(camp('Sourcing', { google_api_requests: 1 }), leads(['New', 'Enriching', 'Enriched', 'Rejected']));
    expect(p.steps.map((s) => s.state)).toEqual(['done', 'done', 'active', 'pending', 'pending']);
    expect(p.steps[2].detail).toBe('2 von 4 geprüft · 3 passend · 1 aussortiert');
  });
  test('enrichment finished, emails being written', () => {
    const p = S.progress(camp('Sourcing'), leads(['Drafting', 'Approved', 'Rejected']));
    expect(p.steps.map((s) => s.state)).toEqual(['done', 'done', 'done', 'active', 'pending']);
    expect(p.steps[3].detail).toBe('1 freigegeben');
  });
  test('Ready: everything done, next step is Slack', () => {
    const p = S.progress(camp('Ready'), leads(['Approved', 'Approved', 'Needs review', 'Rejected']));
    expect(p.steps.every((s) => s.state === 'done')).toBe(true);
    expect(p.steps[3].detail).toBe('2 freigegeben · 1 zur Prüfung');
    expect(p.steps[4].label).toBe('Bereit zum Start');
    expect(p.ready && !p.live).toBe(true);
  });
  test('Live: later lead statuses still count as approved', () => {
    const p = S.progress(camp('Live'), leads(['Contacted', 'Interested', 'Meeting booked']));
    expect(p.approved).toBe(3);
    expect(p.steps[4].label).toBe('Kampagne läuft');
  });
  test('no input', () => expect(S.progress().steps[1].state).toBe('active'));
});

describe('renderStatusPage', () => {
  test('in progress: refreshes itself and explains that click 1 is done', () => {
    const h = S.renderStatusPage({ campaign: camp('Sourcing'), leads: [] });
    expect(h).toMatch(/<meta http-equiv="refresh" content="5">/);
    expect(h).toMatch(/Ihre Kampagne wird vorbereitet/);
    expect(h).toMatch(/Klick 1 ist erledigt/);
  });
  test('Ready: stops refreshing, tells the next two clicks, lists approved leads and the Airtable link', () => {
    const h = S.renderStatusPage({ campaign: camp('Ready'), leads: leads(['Approved', 'Rejected']), airtableUrl: 'https://airtable.com/appX' });
    expect(h).not.toMatch(/http-equiv="refresh"/);
    expect(h).toMatch(/Klick 2 und 3 in Slack/);
    expect(h).toMatch(/Approve and launch/);
    expect(h).toMatch(/<td>Firma 0<\/td>/);
    expect(h).not.toMatch(/Firma 1/);
    expect(h).toMatch(/href="https:\/\/airtable.com\/appX"/);
    expect(S.renderStatusPage({ campaign: camp('Ready'), leads: [], dashboardUrl: '/webhook/dashboard?client=c1' })).toMatch(/href="\/webhook\/dashboard\?client=c1">Zum Dashboard/);
  });
  test('escapes company data (no HTML injection from scraped websites)', () => {
    const h = S.renderStatusPage({ campaign: camp('Ready', { name: '<script>x</script>' }), leads: [{ status: 'Approved', company_name: '<img src=x onerror=alert(1)>', contact_name: 'A & B' }] });
    expect(h).not.toMatch(/<script>x/);
    expect(h).not.toMatch(/<img src=x/);
    expect(h).toMatch(/&lt;img src=x onerror=alert\(1\)&gt;/);
    expect(h).toMatch(/A &amp; B/);
  });
  test('unknown campaign', () => {
    expect(S.renderStatusPage({ notFound: true })).toMatch(/Kampagne nicht gefunden/);
    expect(S.renderStatusPage()).toMatch(/Kampagne nicht gefunden/);
  });
  test('works at phone width and in dark mode', () => {
    const h = S.renderStatusPage({ campaign: camp('Sourcing'), leads: [] });
    expect(h).toMatch(/name="viewport"/);
    expect(h).toMatch(/prefers-color-scheme:dark/);
  });
  test('esc handles empty values', () => expect(S.esc(null) + S.esc(undefined)).toBe(''));
});
