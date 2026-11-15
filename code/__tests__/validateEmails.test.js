const V = require('../validateEmails');

const footer = V.buildFooter({ sender_company_footer: 'Nexsale GmbH · Musterstraße 1, 10115 Berlin · GF: Max Muster · HRB 000000 B' });
// sample message text: n words, the last one a question (every email needs a closing call to action)
// (two paragraphs, as a real first email needs; the word count is unchanged)
const body = (n) => Array.from({ length: n }, (_, i) => 'Wort' + i).map((w, i) => (i === Math.floor(n / 2) ? '\n\n' + w : w)).join(' ').replace(/ \n\n/, '\n\n') + '?';
const good = () => [1, 2, 3, 4].map((step) => ({ step, subject: 'Ihre Reinigungsteams in Kreuzberg', body: 'Guten Tag Herr Becker, ' + body(40) + '\n\nViele Grüße\nAnna Berger' }));

describe('validateSequence', () => {
  test('a good sequence passes', () => expect(V.validateSequence(good(), { footer })).toEqual({ ok: true, errors: [] }));
  test('rejects bodies of 90 words or more', () => {
    const s = good();
    s[1].body = body(90);
    const r = V.validateSequence(s);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/step 2: body has 90 words/);
  });
  test('89 words is fine', () => {
    const s = good();
    s[0].body = 'Guten Tag, ' + body(84) + ' Viele Grüße Anna';
    expect(V.validateSequence(s).ok).toBe(true);
  });
  test('footer words do not count', () => {
    const s = good();
    s[0].body = V.appendFooter('Guten Tag, ' + body(80) + '\nViele Grüße\nAnna', footer);
    expect(V.validateSequence(s, { footer }).ok).toBe(true);
  });
  test.each(['Hast du kurz Zeit?', 'Wir helfen dir gerne.', 'Wie läuft dein Vertrieb?', 'Was macht ihr habt'])('rejects informal "du": %s', (t) => {
    const s = good();
    s[2].body = t;
    expect(V.validateSequence(s).errors.join()).toMatch(/informal/);
  });
  test('formal "Ihr" is allowed', () => {
    const s = good();
    s[0].body = 'Guten Tag, Ihr Team leistet gute Arbeit. Wie gewinnen Sie Ihre Kunden?\nViele Grüße\nAnna';
    expect(V.validateSequence(s).ok).toBe(true);
  });
  test.each(['Hallo {{first_name}}', 'Hallo [Name]', 'Grüße <<sender>>', 'TODO Text'])('rejects leftover placeholder: %s', (t) => {
    const s = good();
    s[3].body = t;
    expect(V.validateSequence(s).errors.join()).toMatch(/placeholder/);
  });
  test('rejects exclamation marks', () => {
    const s = good();
    s[0].subject = 'Toll!';
    expect(V.validateSequence(s).errors.join()).toMatch(/exclamation/);
  });
  test('rejects missing legal footer when required', () => {
    const s = good();
    const r = V.validateSequence(s, { footer, requireFooter: true });
    expect(r.errors.filter((e) => /legal footer missing/.test(e))).toHaveLength(4);
    const withFooter = s.map((e) => Object.assign({}, e, { body: V.appendFooter(e.body, footer) }));
    expect(V.validateSequence(withFooter, { footer, requireFooter: true }).ok).toBe(true);
  });
  test('wrong count, steps and shapes', () => {
    expect(V.validateSequence(good().slice(0, 3)).errors.join()).toMatch(/expected 4 emails/);
    const s = good();
    s[3].step = 3;
    expect(V.validateSequence(s).errors.join()).toMatch(/steps must be/);
    expect(V.validateSequence('x').ok).toBe(false);
    expect(V.validateEmail(null)).toEqual(['email is not an object']);
    const e = V.validateEmail({ step: 1, subject: '', body: '' });
    expect(e.join()).toMatch(/subject missing.*body missing/);
    expect(V.validateEmail({ step: 1, subject: 'x'.repeat(81), body: 'ok' }).join()).toMatch(/longer than 80/);
  });
});

test('greeting, sign-off and sender name are required (live: model dropped them once)', () => {
  const ok = { step: 1, subject: 'Betreff', body: 'Guten Tag Herr Dahan,\n\nkurzer Text. Passt ein Telefonat?\n\nViele Grüße\nAnna Berger' };
  expect(V.validateEmail(ok, { senderName: 'Anna Berger' })).toEqual([]);
  expect(V.validateEmail(Object.assign({}, ok, { body: 'Sie reinigen Arztpraxen in Berlin. Passt ein Telefonat?' })).join()).toMatch(/greeting missing.*sign-off missing/);
  expect(V.validateEmail(Object.assign({}, ok, { body: 'Guten Tag,\n\nText.\n\nViele Grüße\nMax' }), { senderName: 'Anna Berger' }).join()).toMatch(/sender name missing/);
  expect(V.validateEmail(Object.assign({}, ok, { body: 'Hello Mr Dahan,\n\nText. Would a call suit you?\n\nBest regards\nAnna Berger' }), { senderName: 'Anna Berger' })).toEqual([]);
});

test('ensureFrame: code writes salutation and signature, the model only the message (never doubled)', () => {
  const o = { contactName: 'Luan Muster', senderName: 'Anna Berger' };
  const framed = 'Guten Tag Luan Muster,\n\nSie reinigen Praxen.\nPasst ein Telefonat?\n\nMit freundlichen Grüßen\n\nAnna Berger';
  expect(V.ensureFrame('Sie reinigen Praxen.\nPasst ein Telefonat?', o)).toBe(framed);
  // the model's own greeting and sign-off are replaced, not kept or doubled; a guessed "Herr" is dropped
  expect(V.ensureFrame('Guten Tag Herr Muster,\n\nSie reinigen Praxen.\nPasst ein Telefonat?\n\nViele Grüße\nAnna Berger', o)).toBe(framed);
  expect(V.ensureFrame(framed, o)).toBe(framed);
  expect(V.ensureFrame('Text.\nViele Grüße', o)).toBe('Guten Tag Luan Muster,\n\nText.\n\nMit freundlichen Grüßen\n\nAnna Berger');
  expect(V.ensureFrame('Text.', { contactName: 'unbekannt' })).toBe('Sehr geehrte Damen und Herren,\n\nText.\n\nMit freundlichen Grüßen\n\nAnna Berger');
  expect(V.ensureFrame('', o)).toBe('');
  expect(V.validateEmail({ step: 1, subject: 'S', body: V.ensureFrame('Text. Passt ein Telefonat?', o) }, { senderName: 'Anna Berger' })).toEqual([]);
});

test('salutationLine: Herr/Frau only from the Impressum, never guessed', () => {
  expect(V.salutationLine({ contactName: 'Sükrü Oral', contactSalutation: 'Herr' })).toBe('Sehr geehrter Herr Oral,');
  expect(V.salutationLine({ contactName: 'Petra Klein', contactSalutation: 'Frau' })).toBe('Sehr geehrte Frau Klein,');
  expect(V.salutationLine({ contactName: 'Anna Weiß', contactSalutation: 'Frau Dr.' })).toBe('Sehr geehrte Frau Dr. Weiß,');
  expect(V.salutationLine({ contactName: 'Dr. Hans von Berg', contactSalutation: 'Herr' })).toBe('Sehr geehrter Herr Dr. Berg,');
  expect(V.salutationLine({ contactName: 'Sükrü Oral' })).toBe('Guten Tag Sükrü Oral,');
  expect(V.salutationLine({ contactName: 'Kim Meyer', contactSalutation: 'Divers' })).toBe('Guten Tag Kim Meyer,');
  expect(V.salutationLine({ contactName: '' })).toBe('Sehr geehrte Damen und Herren,');
  expect(V.salutationLine()).toBe('Sehr geehrte Damen und Herren,');
});

test('buildSignature: full block, empty fields left out', () => {
  expect(V.buildSignature({ sender_name: 'Anna Berger', sender_title: 'Business Development', sender_company: 'Nexsale GmbH', sender_phone: '+49 30 1234567', sender_website: 'https://www.nexsale.de/' }))
    .toBe('Mit freundlichen Grüßen\n\nAnna Berger\nBusiness Development\nNexsale GmbH\nTel. +49 30 1234567 · www.nexsale.de');
  expect(V.buildSignature({ sender_name: 'Anna Berger' })).toBe('Mit freundlichen Grüßen\n\nAnna Berger');
  expect(V.buildSignature()).toBe('Mit freundlichen Grüßen\n\nAnna Berger');
});

test('word limit counts the message only, not salutation, signature or footer', () => {
  const msg = Array(42).fill('Wort').join(' ') + '\n\n' + Array(43).fill('Wort').join(' ') + '?';
  const sig = V.buildSignature({ sender_name: 'Anna Berger', sender_title: 'Business Development Manager', sender_company: 'Nexsale GmbH', sender_phone: '+49 30 1234567', sender_website: 'nexsale.de' });
  const body = V.appendFooter(V.ensureFrame(msg, { contactName: 'Sükrü Oral', contactSalutation: 'Herr', signature: sig }), V.buildFooter());
  expect(V.messageText(body)).toBe(msg);
  expect(V.validateEmail({ step: 1, subject: 'S', body }, { senderName: 'Anna Berger', requireFooter: true })).toEqual([]);
  const long = V.ensureFrame(Array(90).fill('Wort').join(' '), { contactName: 'X Y' });
  expect(V.validateEmail({ step: 1, subject: 'S', body: long }).join()).toMatch(/90 words/);
});

test('filler phrases are rejected in code', () => {
  ['Wir helfen Firmen wie Ihrer.', 'Unternehmen wie Ihres profitieren.', 'Als zuverlässiger Partner', 'Konzentrieren Sie sich auf Ihre Kernkompetenzen.', 'Ich hoffe, es geht Ihnen gut.', 'ein umfassendes Angebot', 'Eine Win-win-Situation']
    .forEach((t) => expect(V.validateEmail({ step: 1, subject: 'S', body: 'Guten Tag,\n\n' + t + ' Passt ein Telefonat?\n\nViele Grüße\nA' }).join()).toMatch(/filler phrase/));
  expect(V.validateEmail({ step: 1, subject: 'S', body: 'Guten Tag,\n\nSie reinigen Praxen in Pankow. Passt ein Telefonat?\n\nViele Grüße\nA' })).toEqual([]);
});

test('the last paragraph must ask a question (one clear call to action)', () => {
  const e = (t) => V.validateEmail({ step: 2, subject: 'S', body: V.ensureFrame(t, { contactName: 'A B' }) }).join();
  expect(e('Sie reinigen Praxen.\n\nIch würde gern mit Ihnen sprechen.')).toMatch(/step 2: no question/);
  expect(e('Haben Sie Zeit?\n\nSo können Sie wachsen.')).toMatch(/no question/);
  expect(e('Sie reinigen Praxen.\n\nPasst Ihnen Dienstag oder Donnerstag?')).toBe('');
  // a sentence that starts with "Guten Tag" is message text, not the salutation
  expect(V.messageText('Guten Tag, Ihr Team in Pankow. Wie gewinnen Sie Kunden?')).toBe('Guten Tag, Ihr Team in Pankow. Wie gewinnen Sie Kunden?');
});

test('a first email of 40+ words must not be one block of text', () => {
  const block = Array(45).fill('Wort').join(' ') + '?';
  expect(V.validateEmail({ step: 1, subject: 'S', body: V.ensureFrame(block, { contactName: 'A B' }) }).join()).toMatch(/one block of text/);
  expect(V.validateEmail({ step: 2, subject: 'S', body: V.ensureFrame(block, { contactName: 'A B' }) }).join()).not.toMatch(/one block/);
  expect(V.validateEmail({ step: 1, subject: 'S', body: V.ensureFrame('Kurz. Passt es?', { contactName: 'A B' }) })).toEqual([]);
});

test('buildFooter: company details, data source (GDPR) and STOP opt-out', () => {
  const f = V.buildFooter({ sender_company_footer: 'Nexsale GmbH · Musterstr. 1, 10115 Berlin · HRB 1 B' });
  expect(f.split('\n')).toEqual(['-- ', 'Nexsale GmbH · Musterstr. 1, 10115 Berlin · HRB 1 B',
    'Ihre geschäftlichen Kontaktdaten stammen aus dem öffentlichen Impressum Ihrer Website.', 'Antworten Sie mit STOP, wenn Sie keine weiteren E-Mails erhalten möchten.']);
  expect(f).toContain(V.FOOTER_MARKER);
});

test('appendFooter is idempotent; buildFooter defaults', () => {
  const once = V.appendFooter('Text', footer);
  expect(V.appendFooter(once, footer)).toBe(once);
  expect(V.buildFooter()).toMatch(/Nexsale GmbH/);
  expect(V.buildFooter({ name: 'Real Service GmbH' })).toMatch(/Real Service GmbH/);
  expect(V.stripFooter('a\n-- \nfooter')).toBe('a');
});

test('normaliseSequence turns literal "\\n" from the AI into real line breaks (seen live)', () => {
  const seq = V.normaliseSequence({ emails: [{ step: 1, subject: 'Betreff\\nzwei', body: 'Guten Tag Herr Muster,\\n\\nText. \\nViele Grüße\\r\\nAnna' }] });
  expect(seq[0].body).toBe('Guten Tag Herr Muster,\n\nText.\nViele Grüße\nAnna');
  expect(seq[0].subject).toBe('Betreff zwei');
  expect(seq[0].body).not.toMatch(/\\n/);
});

test('normaliseSequence', () => {
  expect(V.normaliseSequence({ emails: [{ subject: ' a ', body: 'b' }] })).toEqual([{ step: 1, subject: 'a', body: 'b' }]);
  expect(V.normaliseSequence([{ step: '2', subject: 'a', body: 'b' }])[0].step).toBe(2);
  expect(V.normaliseSequence({ foo: 1 })).toBeNull();
  expect(V.normaliseSequence(null)).toBeNull();
});

test('countWords ignores punctuation-only tokens', () => {
  expect(V.countWords('Hallo – Welt , 3')).toBe(3);
  expect(V.countWords('')).toBe(0);
});

describe("Nexsale's own rules (blog): follow-ups max 50 words, subject max 5 words", () => {
  const msg = (n) => Array.from({ length: n }, (_, i) => 'Wort' + i).map((w, i) => (i === Math.floor(n / 2) ? '\n\n' + w : w)).join(' ').replace(/ \n\n/, '\n\n') + '?';
  const mail = (step, n, subject) => ({ step, subject: subject || 'Neue Kunden für Pankow', body: V.ensureFrame(msg(n), { contactName: 'A B' }) });
  test('follow-up: 50 words ok, 51 rejected; first email may have up to 89', () => {
    expect(V.validateEmail(mail(2, 50))).toEqual([]);
    expect(V.validateEmail(mail(3, 51)).join()).toMatch(/step 3: follow-up has 51 words \(max 50\)/);
    expect(V.validateEmail(mail(1, 89))).toEqual([]);
  });
  test('subject of email 1: max 5 words; follow-up subjects are replaced by "Re: …" in the thread', () => {
    expect(V.validateEmail(mail(1, 20, 'Neue Gewerbekunden für Real Service'))).toEqual([]);
    expect(V.validateEmail(mail(1, 20, 'Neue Gewerbekunden für Real Service in Berlin')).join()).toMatch(/step 1: subject has 7 words \(max 5\)/);
    expect(V.validateEmail(mail(2, 20, 'Ein langer Betreff mit sehr vielen Worten'))).toEqual([]);
  });
});

describe('paragraphs are formatted by code, words never change (decision 55)', () => {
  const block = 'Sie verwalten über 7.000 Einheiten in Berlin und Cottbus, darunter viele Wohnanlagen mit Treppenhäusern. Mein Name ist Laura Schmidt, Vertrieb bei Real Service GmbH. Wir übernehmen die regelmäßige Unterhaltsreinigung von Wohnanlagen und Treppenhäusern in Berlin mit festen Teams. Passt Ihnen ein kurzes Telefonat von 15 Minuten?';
  test('a single block becomes opening / middle / closing question', () => {
    const p = V.formatParagraphs(block).split('\n\n');
    expect(p).toHaveLength(3);
    expect(p[0]).toMatch(/^Sie verwalten über 7\.000 Einheiten/);
    expect(p[2]).toBe('Passt Ihnen ein kurzes Telefonat von 15 Minuten?');
    expect(V.formatParagraphs(block).replace(/\s+/g, ' ')).toBe(block.replace(/\s+/g, ' ')); // same words
  });
  test('single line breaks become paragraphs; existing paragraphs and short texts stay', () => {
    expect(V.formatParagraphs('Satz eins.\nSatz zwei?')).toBe('Satz eins.\n\nSatz zwei?');
    expect(V.formatParagraphs('A.\n\nB?')).toBe('A.\n\nB?');
    expect(V.formatParagraphs('Kurz. Passt es?')).toBe('Kurz. Passt es?');
    expect(V.formatParagraphs('')).toBe('');
    // abbreviations and numbers never split a sentence
    const abbr = 'Sie betreuen z. B. Praxen mit ca. 1.200 m² in Mitte und dazu viele Büros im Umland mit festen Teams und klaren Zeiten. Wir reinigen täglich nach Plan, dokumentieren jede Reinigung sauber für Sie und schicken Ihnen monatlich einen kurzen Bericht. Passt Ihnen ein kurzes Telefonat?';
    expect(V.formatParagraphs(abbr).split('\n\n')).toEqual(['Sie betreuen z. B. Praxen mit ca. 1.200 m² in Mitte und dazu viele Büros im Umland mit festen Teams und klaren Zeiten.',
      'Wir reinigen täglich nach Plan, dokumentieren jede Reinigung sauber für Sie und schicken Ihnen monatlich einen kurzen Bericht.', 'Passt Ihnen ein kurzes Telefonat?']);
  });
  test('the formatted first email passes the paragraph rule', () => {
    const body = V.ensureFrame(block, { contactName: 'A B', paragraphs: true });
    expect(V.validateEmail({ step: 1, subject: 'Reinigung für ABAKUS', body })).toEqual([]);
    expect(V.validateEmail({ step: 1, subject: 'Reinigung für ABAKUS', body: V.ensureFrame(block, { contactName: 'A B' }) }).join()).toMatch(/one block of text/);
  });
});
