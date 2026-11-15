const fs = require('fs');
const path = require('path');
const P = require('../parseImpressum');

const DIR = path.join(__dirname, '../../tests/fixtures/impressum');
const expected = JSON.parse(fs.readFileSync(path.join(DIR, 'expected.json'), 'utf8'));
const domains = JSON.parse(fs.readFileSync(path.join(__dirname, '../../tests/fixtures/web_map.json'), 'utf8'));
const domainFor = (key) => Object.keys(domains).find((d) => Object.values(domains[d]).includes(`impressum/${key}.html`));

describe('parseImpressum on every fixture page', () => {
  Object.entries(expected).forEach(([key, exp]) => {
    test(key, () => {
      const html = fs.readFileSync(path.join(DIR, key + '.html'), 'utf8');
      const domain = domainFor(key) || 'weissensee-clean.example';
      const r = P.parseImpressum(html, domain);
      expect(r.email).toBe(exp.email);
      expect(r.contact_name).toBe(exp.contact_name);
      expect(r.contact_role).toBe(exp.contact_role);
      expect(r.register_number).toBe(exp.register_number);
      expect(r.legal_form).toBe(exp.legal_form);
      if (exp.contact_names) expect(r.contact_names).toEqual(exp.contact_names);
    });
  });
});

describe('hard cases never crash', () => {
  test.each([[null], [undefined], [''], [42], ['<html></html>'], ['<<<>>>'], ['Geschäftsführer:']])('input %p', (input) => {
    const r = P.parseImpressum(input, 'x.example');
    expect(r.email).toBeNull();
    expect(r.contact_name).toBeNull();
  });
});

describe('helpers', () => {
  test('stripHtml removes scripts and decodes entities', () => {
    const t = P.stripHtml('<script>var a="x@y.de"</script><p>M&uuml;ller &amp; S&ouml;hne&nbsp;GmbH</p>');
    expect(t).toBe('Müller & Söhne GmbH');
    expect(P.stripHtml('')).toBe('');
    expect(P.stripHtml('&#228;&#xE4;&unknown;')).toBe('ää&unknown;');
  });
  test('deobfuscate [at] and (dot) variants', () => {
    expect(P.extractEmails('info [at] firma.de')).toEqual(['info@firma.de']);
    expect(P.extractEmails('max (at) firma (punkt) de')).toEqual(['max@firma.de']);
    expect(P.extractEmails('anna{at}firma{dot}de')).toEqual(['anna@firma.de']);
    expect(P.extractEmails('logo@2x.png')).toEqual([]);
  });
  test('pickEmail prefers personal over info and ignores other domains', () => {
    expect(P.pickEmail(['info@a.de', 'max@a.de'], 'a.de')).toBe('max@a.de');
    expect(P.pickEmail(['info@a.de', 'kontakt@a.de'], 'a.de')).toBe('kontakt@a.de');
    expect(P.pickEmail(['info@a.de'], 'a.de')).toBe('info@a.de');
    expect(P.pickEmail(['max@other.de'], 'a.de')).toBeNull();
    expect(P.pickEmail(['datenschutz@a.de'], 'a.de')).toBeNull();
    expect(P.pickEmail(['max@shop.a.de'], 'a.de')).toBe('max@shop.a.de');
  });
  test('register number formats', () => {
    expect(P.extractRegister('HRB 12345')).toBe('HRB 12345');
    expect(P.extractRegister('HR B 12345 B')).toBe('HRB 12345 B');
    expect(P.extractRegister('nothing')).toBeNull();
  });
  test('legal forms', () => {
    expect(P.extractLegalForm('Muster UG (haftungsbeschränkt)')).toBe('UG (haftungsbeschränkt)');
    expect(P.extractLegalForm('Muster OHG')).toBe('OHG');
    expect(P.extractLegalForm('Muster KG')).toBe('KG');
    expect(P.extractLegalForm('Einzelunternehmen Maier')).toBe('Einzelunternehmen');
    expect(P.extractLegalForm('Muster gGmbH')).toBe('gGmbH');
    expect(P.extractLegalForm('Firma ohne Form')).toBeNull();
  });
  test('name on the line after the role heading', () => {
    expect(P.extractNames('Geschäftsführer:\nFlorian Huber').names).toEqual(['Florian Huber']);
  });
  test('stop words end a name', () => {
    expect(P.extractNames('Inhaber: Max Mustermann Telefon 030 1').names).toEqual(['Max Mustermann']);
    expect(P.extractNames('Inhaber: Max').names).toEqual([]);
  });
  test('findImpressumLink', () => {
    expect(P.findImpressumLink('<a href="/rechtliches/anbieter">Impressum</a>')).toBe('/rechtliches/anbieter');
    expect(P.findImpressumLink('<a href="https://x.de/impressum.html">Legal</a>')).toBe('/impressum.html');
    expect(P.findImpressumLink('<a href="imprint">x</a>')).toBe('/imprint');
    expect(P.findImpressumLink('<a href="/kontakt">Kontakt</a>')).toBeNull();
    expect(P.findImpressumLink(null)).toBeNull();
    expect(P.findImpressumLink('<a href="https://[bad/impressum">i</a>')).toBeNull();
  });
});

describe('real-world patterns found in the first live campaign', () => {
  test('email on a related company domain is accepted', () => {
    expect(P.relatedDomain('falcon-sample.de', 'falconsample.de')).toBe(true); // hyphen only
    expect(P.relatedDomain('dreisam-group.com', 'dreisam-service.de')).toBe(true); // shared brand token
    expect(P.relatedDomain('dreisam.de', 'dreisam-service.de', 'Dreisam Service')).toBe(true);
    expect(P.relatedDomain('kunde-gruen.de', 'blau-x.de', 'Gruen Reinigung')).toBe(true); // brand token in the company name
    expect(P.relatedDomain('kunde-gru.de', 'blau-x.de', 'Gru Reinigung')).toBe(false); // tokens under 5 letters never count
    expect(P.relatedDomain('webagentur-pixel.de', 'falconsample.de', 'Falcon Sample')).toBe(false); // web designer
    expect(P.relatedDomain('gmail.com', 'falconsample.de')).toBe(false);
    expect(P.relatedDomain('service-berlin.de', 'reinigung-service-berlin.de')).toBe(false); // generic tokens only
    expect(P.relatedDomain('', 'x.de')).toBe(false);
    const html = '<h1>Impressum</h1><p>Falcon Sample GmbH</p><p>Geschäftsführer: Fatih Beispiel</p><p>E-Mail: info@falcon-sample.de</p><p>Webdesign: hallo@webagentur-pixel.de</p>';
    const r = P.parseImpressum(html, 'falconsample.de', 'Falcon Sample');
    expect(r.email).toBe('info@falcon-sample.de');
  });
  test('own domain still wins over a related one', () => {
    expect(P.pickEmail(['info@brand-group.com', 'info@brand-service.de'], 'brand-service.de')).toBe('info@brand-service.de');
  });
  test('salutations are not part of the name', () => {
    expect(P.extractNames('Geschäftsführer: Herr Rafael Beispiel').names).toEqual(['Rafael Beispiel']);
    expect(P.extractNames('Inhaberin: Frau Dr. Anna Muster').names).toEqual(['Anna Muster']);
  });
});

describe('live cases from Leipzig and Dresden (decision 46)', () => {
  test("a small firm's own free-mail address counts when it clearly belongs to the company or owner", () => {
    expect(P.pickEmail(['glanzmarvinreinigung@gmail.com'], 'glanzmarvin.de', 'GLANZMARVIN Glas- und Gebäudereinigung')).toBe('glanzmarvinreinigung@gmail.com');
    expect(P.pickEmail(['sabani.kenan@hotmail.com'], 'kens-reinigungsservice-leipzig.de', 'Kens Reinigungsservice', 'Kenan Sabani')).toBe('sabani.kenan@hotmail.com');
    expect(P.pickEmail(['esj.dienstleistungen@outlook.de'], 'esjdienstleistung.de', 'ESJ.Dienstleistungen')).toBe('esj.dienstleistungen@outlook.de');
  });
  test('template and tracking addresses never count', () => {
    expect(P.pickEmail(['business@gmx.de'], 'falken-service.onepage.me', 'Reinigungsfirma Leipzig')).toBeNull();
    expect(P.pickEmail(['support@deinunternehmen.name'], 'falken-service.onepage.me', 'Reinigungsfirma Leipzig')).toBeNull();
    expect(P.pickEmail(['605a7b@sentry-next.wixpress.com', '8c40@sentry.io'], 'esjdienstleistung.de', 'ESJ')).toBeNull();
    expect(P.companyFreeMail('info@firma.de', 'firma.de', 'Firma')).toBe(false);
    expect(P.pickEmail(['name@beispiel.de'], 'cleno.de', 'cleno')).toBeNull(); // contact-form placeholder
  });
  test('the company domain still wins over free-mail', () => {
    expect(P.pickEmail(['owner@gmail.com', 'info@glanz.de'], 'glanz.de', 'Glanz')).toBe('info@glanz.de');
  });
  test('an address that is only in a mailto: link is found', () => {
    const r = P.parseImpressum('<p>Inhaber: Senat Kurtishov</p><a href="mailto:Esj.dienstleistungen@outlook.de">Schreiben Sie uns</a>', 'esjdienstleistung.de', 'ESJ.Dienstleistungen');
    expect(r.email).toBe('esj.dienstleistungen@outlook.de');
  });
  test('a company name is never taken as a person', () => {
    expect(P.parseImpressum('<p>Inhaber: ADVISA-Service Reinigungsfirma</p>', 'advisa-service-fm.de').contact_name).toBeNull();
    expect(P.parseImpressum('<p>Inhaber: Wolfgang Speck</p>', 'x.de').contact_name).toBe('Wolfgang Speck');
  });
});
