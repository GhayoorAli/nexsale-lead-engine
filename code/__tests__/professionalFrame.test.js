const V = require('../validateEmails');
const VA = require('../validators');
const REM = require('../reminders');

const client = { sender_name: 'Anna Berger', sender_title: 'Business Development', sender_company: 'Nexsale GmbH', sender_phone: '+49 30 1234567', sender_website: 'nexsale.de' };

test('offerText: client offer wins, default has no numbers or promises', () => {
  expect(V.offerText({ offer: 'Unser Angebot.' }, 'X')).toBe('Unser Angebot.');
  const d = V.offerText({}, 'Reinigungsunternehmen');
  expect(d).toMatch(/Neukundengewinnung/);
  expect(d).toMatch(/"Reinigungsunternehmen"/);
  expect(d).not.toMatch(/\d/);
  expect(V.offerText()).toMatch(/^Wir übernehmen für Unternehmen die/);
});

test('auto-answer to an interested lead gets the same formal frame', () => {
  const frame = { frame: true, contactName: 'Sükrü Oral', contactSalutation: 'Herr', signature: V.buildSignature(client) };
  const p = VA.prepareByPrompt('interested_reply', { body: 'Guten Tag Herr Oral,\n\nvielen Dank für Ihre Rückmeldung. Termin: https://calendly.com/x\n\nViele Grüße\nAnna Berger' }, frame, V);
  expect(p.body).toContain('\n\nvielen Dank für Ihre Rückmeldung. Termin: https://calendly.com/x\n\nMit freundlichen');
  expect(p.body.startsWith('Sehr geehrter Herr Oral,\n\n')).toBe(true);
  expect(p.body.endsWith('Mit freundlichen Grüßen\n\nAnna Berger\nBusiness Development\nNexsale GmbH\nTel. +49 30 1234567 · nexsale.de')).toBe(true);
  // without frame option (old callers) nothing changes
  const raw = { body: 'Text' };
  expect(VA.prepareByPrompt('interested_reply', raw, {}, V)).toBe(raw);
});

test('a sign-off phrase inside the message is never cut, only a trailing one', () => {
  expect(V.messageText('Viele Grüße an Ihr Team in Pankow. Passt ein Telefonat?')).toBe('Viele Grüße an Ihr Team in Pankow. Passt ein Telefonat?');
  expect(V.messageText('Text.\nViele Grüße\nAnna')).toBe('Text.');
  const longTail = 'Text.\nViele Grüße' + ' x'.repeat(200);
  expect(V.messageText(longTail)).toBe(longTail);
});

test('reminder email uses salutation and signature when the frame module is given', () => {
  const e = REM.reminderEmail({}, { email: 'a@b.de', contact_name: 'Petra Klein', contact_salutation: 'Frau' }, client, 'Freitag, 21. November 2026 um 10:00 Uhr', V);
  expect(e.body).toMatch(/^Sehr geehrte Frau Klein,\n\nich freue mich auf unser Gespräch am Freitag/);
  expect(e.body).toMatch(/Mit freundlichen Grüßen\n\nAnna Berger\nBusiness Development/);
  expect(e.to).toBe('a@b.de');
});
