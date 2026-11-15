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
