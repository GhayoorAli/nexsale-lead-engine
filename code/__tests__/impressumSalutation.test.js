const P = require('../parseImpressum');
const sal = (html) => P.parseImpressum(html, 'firma.de').contact_salutation;

test('Herr/Frau and academic titles come from the Impressum text', () => {
  expect(sal('<p>Geschäftsführer: Herr Sükrü Oral</p>')).toBe('Herr');
  expect(sal('<p>Vertreten durch: Frau Dr. Anna Weiß</p>')).toBe('Frau Dr.');
  expect(sal('<p>Inhaber: Hr. Prof. Dr. Karl Berg</p>')).toBe('Herr Prof. Dr.');
  expect(P.parseImpressum('<p>Vertreten durch: Frau Dr. Anna Weiß</p>', 'firma.de').contact_name).toBe('Anna Weiß');
});

test('a female role form names one person as Frau', () => {
  expect(sal('<p>Geschäftsführerin: Petra Klein</p>')).toBe('Frau');
  expect(sal('<p>Inhaberin: Petra Klein</p>')).toBe('Frau');
});

test('never guessed: plain role or several names → no salutation', () => {
  expect(sal('<p>Geschäftsführer: Max Muster</p>')).toBeNull();
  expect(sal('<p>Geschäftsführerin: Anna Klein und Bernd Roth</p>')).toBeNull();
  expect(sal('<p>Kein Name hier</p>')).toBeNull();
  expect(P.parseImpressum(null).contact_salutation).toBeNull();
});
