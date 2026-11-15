const M = require('../mime');

test('builds a UTF-8 message that round-trips', () => {
  const raw = M.buildRawEmail({ from: 's@x.de', fromName: 'Jörg Müller', to: 'p@x.de', subject: '[TEST] Grüße aus Köln', body: 'Guten Tag,\nÄrger vermeiden.' });
  expect(raw).not.toMatch(/[+/=]/);
  const d = M.decodeRawEmail(raw);
  expect(d.subject).toBe('[TEST] Grüße aus Köln');
  expect(d.to).toBe('p@x.de');
  expect(d.body).toBe('Guten Tag,\nÄrger vermeiden.');
  expect(d.headers.from).toMatch(/=\?UTF-8\?B\?/);
});
test('threading headers', () => {
  const d = M.decodeRawEmail(M.buildRawEmail({ from: 's@x.de', to: 'p@x.de', subject: 'Re: a', body: 'b', inReplyTo: '<abc@mail>', listUnsubscribe: '<mailto:s@x.de?subject=STOP>' }));
  expect(d.headers['in-reply-to']).toBe('<abc@mail>');
  expect(d.headers.references).toBe('<abc@mail>');
  expect(d.headers['list-unsubscribe']).toMatch(/STOP/);
});
test('long bodies are wrapped and ascii headers untouched', () => {
  const d = M.decodeRawEmail(M.buildRawEmail({ to: 'p@x.de', subject: 'plain', body: 'x'.repeat(500) }));
  expect(d.body).toHaveLength(500);
  expect(M.encodeHeader('plain')).toBe('plain');
  expect(M.encodeHeader()).toBe('');
});
test('requires to', () => expect(() => M.buildRawEmail({})).toThrow(/to/));

test('test marker header and HTML alternative round-trip', () => {
  const M2 = require('../mime');
  const raw = M2.buildRawEmail({ from: 's@x.de', to: 'p@x.de', subject: 'Kampagne bereit', body: 'Text-Version', html: '<p>HTML-Version</p>', extraHeaders: { 'X-Nexsale-Test': 'true', 'Bad Header': 'x', 'X-Evil': 'a\r\nBcc: c@d.de' } });
  const d = M2.decodeRawEmail(raw);
  expect(d.headers['x-nexsale-test']).toBe('true');
  expect(d.headers['bad header']).toBeUndefined();
  expect(d.headers.bcc).toBeUndefined(); // no header injection
  expect(d.headers['content-type']).toMatch(/multipart\/alternative/);
  expect(d.body).toBe('Text-Version');
  expect(d.html).toBe('<p>HTML-Version</p>');
  const plain = M2.decodeRawEmail(M2.buildRawEmail({ from: 's@x.de', to: 'p@x.de', subject: 'S', body: 'Nur Text' }));
  expect(plain.body).toBe('Nur Text');
  expect(plain.html).toBe('');
});
