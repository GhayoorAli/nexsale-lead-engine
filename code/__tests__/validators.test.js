const VA = require('../validators');
const VE = require('../validateEmails');

const v = (id, d, o) => VA.validateByPrompt(id, d, o, VE);

test('opening must be backed by a verbatim detail from the description', () => {
  const summary = 'Die Firma reinigt Arztpraxen und Treppenhäuser in Pankow und Weißensee.';
  const seq = (open) => 'E-Mail 1\nBetreff: X\nGuten Tag Herr Muster,\n\n' + open + ' Mehr Text.\n\nE-Mail 2\nBetreff: Y\nText';
  const d = (detail) => ({ opening_specific: true, opening_detail: detail, invented_claims: [], emails_with_company_detail: [1, 2, 3, 4], filler_phrases: [] });
  expect(VA.openingSentence(seq('Sie reinigen Arztpraxen in Pankow – dort zählt Hygiene.'))).toBe('Sie reinigen Arztpraxen in Pankow – ');
  expect(VA.qualityScore(d('Arztpraxen in Pankow'), { summary, sequence: seq('Sie reinigen Arztpraxen in Pankow – dort zählt Hygiene.') })).toBe(100);
  // the live negative control: generic opening, model claims "specific"
  expect(VA.qualityScore(d('Unternehmen wie Ihres'), { summary, sequence: seq('Unternehmen wie Ihres profitieren von unserer Erfahrung.') })).toBe(65);
  expect(VA.verifiedOpening(d('Arztpraxen'), { summary, sequence: seq('Unternehmen wie Ihres profitieren.') })).toBe(false); // detail not in the opening
  expect(VA.verifiedOpening(d('Zahnarztpraxen in Mitte'), { summary, sequence: seq('Sie reinigen Zahnarztpraxen in Mitte.') })).toBe(false); // not in the description
  expect(VA.verifiedOpening(d('Reinigung in Berlin'), { summary: 'Reinigung in Berlin', sequence: seq('Sie bieten Reinigung in Berlin.') })).toBe(false); // only generic words
  expect(VA.verifiedOpening(d(''), { summary, sequence: seq('x') })).toBe(false);
  expect(VA.verifiedOpening(Object.assign(d('Arztpraxen'), { opening_specific: false }), { summary, sequence: seq('Arztpraxen.') })).toBe(false);
  expect(VA.verifiedOpening(d('Arztpraxen'))).toBe(true); // without context: trust the answer (unit use only)
  expect(VA.openingSentence('')).toBe('');
});

test('reply_classifier', () => {
  expect(v('reply_classifier', { category: 'Interested', confidence: 0.9, return_date: null, summary: 'x' }).ok).toBe(true);
  expect(v('reply_classifier', { category: 'Maybe', confidence: 2, return_date: 'soon', summary: '' }).errors).toHaveLength(4);
  expect(v('reply_classifier', null).ok).toBe(false);
});
test('quality_check: structured answers, score computed in code', () => {
  const good = { opening_specific: true, opening_quote: 'Sie reinigen Arztpraxen in Pankow', invented_claims: [], emails_with_company_detail: [1, 2, 3, 4], filler_phrases: [], issues: [] };
  expect(v('quality_check', good).ok).toBe(true);
  expect(VA.qualityScore(good)).toBe(100);
  expect(VA.qualityScore(Object.assign({}, good, { invented_claims: ['seit 20 Jahren am Markt'] }))).toBe(65); // any invented claim fails the 80 bar
  expect(VA.qualityScore(Object.assign({}, good, { opening_specific: false }))).toBe(65);
  expect(VA.qualityScore(Object.assign({}, good, { emails_with_company_detail: [1, 2] }))).toBe(90);
  expect(VA.qualityScore(Object.assign({}, good, { emails_with_company_detail: [1, 1, 9], filler_phrases: ['umfassend'] }))).toBe(75);
  expect(VA.qualityScore(null)).toBe(0);
  expect(VA.qualityScore({})).toBe(0); // missing answers earn nothing
  expect(v('quality_check', { score: 120 }).errors.length).toBeGreaterThanOrEqual(4);
  expect(v('quality_check', Object.assign({}, good, { issues: 'x' })).ok).toBe(false);
  expect(v('quality_check', 'x').ok).toBe(false);
});
test('company_summary', () => {
  expect(v('company_summary', { summary: 'Zwei Sätze.' }).ok).toBe(true);
  expect(v('company_summary', { summary: 'x'.repeat(700) }).ok).toBe(false);
  expect(v('company_summary', {}).ok).toBe(false);
});
test('impressum_fallback', () => {
  expect(v('impressum_fallback', { contact_name: 'A B', contact_role: null, email: null }).ok).toBe(true);
  expect(v('impressum_fallback', { contact_name: 5 }).ok).toBe(false);
  expect(v('impressum_fallback', null).ok).toBe(false);
});
test('inbound_lead_brief', () => {
  expect(v('inbound_lead_brief', { temperature: 'Hot', brief: 'x' }).ok).toBe(true);
  expect(v('inbound_lead_brief', { temperature: 'lukewarm' }).errors).toHaveLength(2);
  expect(v('inbound_lead_brief', null).ok).toBe(false);
});
test('weekly_report', () => {
  expect(v('weekly_report', { summary: 'a\nb\nc\nd\ne' }).ok).toBe(true);
  expect(v('weekly_report', { summary: 'a\nb\nc\nd\ne\nf\ng\nh' }).ok).toBe(false);
  expect(v('weekly_report', {}).ok).toBe(false);
});
test('interested_reply', () => {
  const o = { calendlyLink: 'https://calendly.com/x' };
  expect(v('interested_reply', { body: 'Gerne, hier: https://calendly.com/x' }, o).ok).toBe(true);
  expect(v('interested_reply', { body: 'Hast du Zeit? {{link}}' }, o).errors).toHaveLength(3);
  expect(v('interested_reply', {}, o).ok).toBe(false);
  expect(v('interested_reply', null, o).ok).toBe(false);
});
test('email_sequence', () => {
  const emails = [1, 2, 3, 4].map((s) => ({ step: s, subject: 'Betreff', body: 'Guten Tag, kurzer Text. Passt ein Telefonat?\nViele Grüße\nAnna Berger' }));
  expect(v('email_sequence', { emails }).ok).toBe(true);
  expect(v('email_sequence', { nope: 1 }).ok).toBe(false);
});
test('unknown prompt', () => expect(v('nope', {}).ok).toBe(false));
test('prepareByPrompt frames email sequences only', () => {
  const d = { emails: [{ step: 1, subject: 'S', body: 'Text.\\nZweite Zeile' }] };
  const p = VA.prepareByPrompt('email_sequence', d, { contactName: 'Anna Muster', senderName: 'Max' }, VE);
  expect(p.emails[0].body).toBe('Guten Tag Anna Muster,\n\nText.\nZweite Zeile\n\nMit freundlichen Grüßen\n\nMax');
  expect(VA.prepareByPrompt('reply_classifier', d, {}, VE)).toBe(d);
  expect(VA.prepareByPrompt('email_sequence', { nope: 1 }, {}, VE)).toEqual({ nope: 1 });
});

test('email_sequence: the A/B subject alternative is held to 5 words as well', () => {
  const VE2 = require('../validateEmails');
  const VA2 = require('../validators');
  const emails = [1, 2, 3, 4].map((s) => ({ step: s, subject: 'Kurzer Betreff', body: 'Guten Tag,\n\nkurzer Text. Passt ein Telefonat?\n\nViele Grüße\nAnna Berger' }));
  emails[0].subject_alt = 'Ein viel zu langer alternativer Betreff hier';
  expect(VA2.validateByPrompt('email_sequence', { emails }, {}, VE2).errors.join()).toMatch(/subject_alt has 7 words/);
  emails[0].subject_alt = 'Kurz und klar';
  expect(VA2.validateByPrompt('email_sequence', { emails }, {}, VE2).ok).toBe(true);
});

test('opening check: the campaign industry and city never count as a distinctive detail', () => {
  const VA3 = require('../validators');
  const seq = 'E-Mail 1\nBetreff: X\nGuten Tag Herr A,\n\nSie bieten Steuerberatung in Hamburg an. Passt ein Telefonat?';
  const d = { opening_specific: true, opening_detail: 'Steuerberatung in Hamburg' };
  const ctx = { summary: 'Kanzlei für Steuerberatung in Hamburg seit 1990', sequence: seq };
  expect(VA3.verifiedOpening(d, Object.assign({ generic: ['Steuerberater', 'Hamburg'] }, ctx))).toBe(false);
  const seq2 = 'E-Mail 1\nBetreff: X\nGuten Tag Herr A,\n\nSie betreuen Ärzte und Apotheken in Eppendorf. Passt ein Telefonat?';
  const d2 = { opening_specific: true, opening_detail: 'Ärzte und Apotheken in Eppendorf' };
  expect(VA3.verifiedOpening(d2, { summary: 'Kanzlei für Ärzte und Apotheken in Eppendorf', sequence: seq2, generic: ['Steuerberater', 'Hamburg'] })).toBe(true);
});

test('company_summary: contacts list and trigger text are optional but typed', () => {
  const VA4 = require('../validators');
  const ok = (d) => VA4.validateByPrompt('company_summary', d).ok;
  expect(ok({ summary: 'A.', contacts: [{ name: 'X Y' }], trigger: '' })).toBe(true);
  expect(ok({ summary: 'A.', contacts: 'Petra' })).toBe(false);
  expect(ok({ summary: 'A.', trigger: 5 })).toBe(false);
});
