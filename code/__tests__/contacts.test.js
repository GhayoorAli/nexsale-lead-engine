const C = require('../contacts');
const P = require('../parseImpressum');

const page = `Unser Team. Geschäftsführer: Max Muster. Objektbetreuung: Frau Petra Klein, p.klein@hv-pankow.de, Tel 030 123.
Buchhaltung: Jens Ott. Wir suchen ab sofort zwei Hausmeister für unsere Wohnanlagen in Pankow.`;
const imp = { contact_name: 'Max Muster', contact_role: 'Geschäftsführer', contact_salutation: null, email: 'info@hv-pankow.de' };
const base = { pageText: page, domain: 'hv-pankow.de', companyName: 'HV Pankow', impressum: imp, relatedDomain: P.relatedDomain };

describe('findPageLinks', () => {
  test('team and jobs links from the homepage, same site only', () => {
    const html = '<a href="/impressum">Impressum</a><a href="https://hv-pankow.de/ueber-uns/team">Über uns</a><a href="https://other.de/team">x</a><a href="karriere.html">Jobs</a>';
    expect(C.findPageLinks(html, 'hv-pankow.de')).toEqual({ team: '/ueber-uns/team', jobs: '/karriere.html' });
  });
  test('link text counts too; fallbacks /kontakt and /karriere', () => {
    expect(C.findPageLinks('<a href="/seite-7">Ansprechpartner</a>', 'x.de').team).toBe('/seite-7');
    expect(C.findPageLinks('', 'x.de')).toEqual({ team: '/kontakt', jobs: '/karriere' });
    expect(C.findPageLinks('<a href="mailto:a@x.de">kontakt</a><a href="#team">t</a>', 'x.de')).toEqual({ team: '/kontakt', jobs: '/karriere' });
  });
  test('sameSiteHref', () => {
    expect(C.sameSiteHref('https://www.x.de/a?b=1', 'x.de')).toBe('/a');
    expect(C.sameSiteHref('tel:123', 'x.de')).toBeNull();
    expect(C.sameSiteHref('https://y.de/a', 'x.de')).toBeNull();
  });
});

describe('pickContact: the right decision-maker, never an invented one', () => {
  const ai = [
    { name: 'Max Muster', role: 'Geschäftsführer', email: '' },
    { name: 'Petra Klein', role: 'Objektbetreuung', email: 'p.klein@hv-pankow.de', salutation: 'Frau' },
    { name: 'Jens Ott', role: 'Buchhaltung' },
  ];
  test('target role "Objektbetreuung" → Frau Petra Klein with her personal email', () => {
    expect(C.pickContact(Object.assign({ contacts: ai, targetRole: 'Objektbetreuung, Geschäftsführer' }, base))).toEqual({
      contact_name: 'Petra Klein', contact_role: 'Objektbetreuung', contact_salutation: 'Frau', email: 'p.klein@hv-pankow.de', contact_source: 'Website (Team/Kontakt)' });
  });
  test('target role Geschäftsführer → keep the Impressum person', () => {
    expect(C.pickContact(Object.assign({ contacts: ai, targetRole: 'Geschäftsführer' }, base)).contact_source).toBe('Impressum');
  });
  test('names or emails that are not on the page are rejected (AI hallucination)', () => {
    const fake = [{ name: 'Sabine Fake', role: 'Objektbetreuung', email: 's@hv-pankow.de' }, { name: 'Petra Klein', role: 'Objektbetreuung', email: 'petra@hv-pankow.de' }];
    const r = C.pickContact(Object.assign({ contacts: fake, targetRole: 'Objektbetreuung' }, base));
    expect(r.contact_name).toBe('Petra Klein');
    expect(r.email).toBe('info@hv-pankow.de'); // invented personal email dropped → Impressum email
  });
  test('Herr/Frau only when written next to the name on the page', () => {
    expect(C.verifiedContact({ name: 'Jens Ott', role: 'x', salutation: 'Herr' }, page, 'hv-pankow.de').salutation).toBe('');
    expect(C.verifiedContact({ name: 'Herr Petra Klein', role: 'x', salutation: 'herr' }, page, 'hv-pankow.de').salutation).toBe('');
    expect(C.verifiedContact({ name: 'X', role: 'y' }, page, 'd')).toBeNull();
    expect(C.verifiedContact(null)).toBeNull();
  });
  test('an email on an unrelated domain is dropped', () => {
    const p2 = page + ' petra@gmail.com';
    const r = C.pickContact(Object.assign({}, base, { pageText: p2, contacts: [{ name: 'Petra Klein', role: 'Objektbetreuung', email: 'petra@gmail.com' }], targetRole: 'Objektbetreuung' }));
    expect(r.email).toBe('info@hv-pankow.de');
  });
  test('no matching role or no AI contacts → Impressum fallback', () => {
    expect(C.pickContact(Object.assign({ contacts: ai, targetRole: 'Einkauf' }, base)).contact_name).toBe('Max Muster');
    expect(C.pickContact(Object.assign({ contacts: 'x', targetRole: 'Objektbetreuung' }, base)).contact_name).toBe('Max Muster');
    expect(C.pickContact({}).contact_source).toBeNull();
  });
  test('role matching by stem and order of wishes', () => {
    const t = C.targetRoleList('Hausdame, Betriebsleitung oder Geschäftsführung');
    expect(t).toEqual(['hausdame', 'betriebsleitung', 'geschäftsführung']);
    expect(C.roleRank('Geschäftsführer', t)).toBe(2);
    expect(C.roleRank('Leitung Housekeeping / Hausdame', t)).toBe(0);
    expect(C.roleRank('', t)).toBe(-1);
  });
});

describe('verifiedTrigger', () => {
  test('a trigger whose words are on the page is kept', () => {
    expect(C.verifiedTrigger('Sucht ab sofort zwei Hausmeister für Wohnanlagen in Pankow', page)).toMatch(/Hausmeister/);
  });
  test('invented or empty triggers are dropped', () => {
    expect(C.verifiedTrigger('Eröffnet neuen Standort in Hamburg-Altona demnächst', page)).toBe('');
    expect(C.verifiedTrigger('kein Anlass', page)).toBe('');
    expect(C.verifiedTrigger('', page)).toBe('');
    expect(C.verifiedTrigger('Hausmeister', page)).toBe('');
  });
});
