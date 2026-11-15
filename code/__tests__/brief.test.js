const B = require('../brief');
const V = require('../validators');
const C = require('../calendly');

const lead = { company_name: 'HV Pankow', city: 'Berlin', website: 'https://hv-pankow.de', contact_name: 'Petra Klein', contact_role: 'Objektbetreuung',
  company_summary: 'Verwaltet 40 Wohnanlagen in Pankow.', trigger: 'Sucht zwei Hausmeister.' };
const replies = [{ received_at: '2026-11-15T10:00:00Z', category: 'Interested', body: 'Klingt interessant,\n  haben Sie Zeit?' }, { body: '' }];
const qa = [{ question: 'Fläche in m²', answer: 'ca. 3.000' }];

test('briefVars: everything the AI may use, nothing else', () => {
  const v = B.briefVars(lead, replies, qa, 'Freitag, 21. November 2026 um 10:00 Uhr', { offer: 'Unterhaltsreinigung' });
  expect(v.thread).toBe('[2026-11-15, Interested] Klingt interessant, haben Sie Zeit?');
  expect(v.booking_answers).toBe('Fläche in m²: ca. 3.000');
  expect(v.offer).toBe('Unterhaltsreinigung');
  expect(B.briefVars({}, [], [], '').thread).toBe('(keine Antworten gespeichert)');
});

test('formatBrief with the AI answer', () => {
  const t = B.formatBrief({ about: 'Hausverwaltung mit 40 Anlagen.', why_now: 'Personalengpass.', conversation: 'Fragt nach Termin.', questions_to_ask: ['Aktueller Dienstleister?', '', 'Vertragsende?'] }, lead, 'Fr 10:00', qa);
  expect(t).toMatch(/^\*Meeting-Briefing: HV Pankow\* · Fr 10:00/);
  expect(t).toMatch(/\*Wer:\* Petra Klein, Objektbetreuung · https:\/\/hv-pankow.de/);
  expect(t).toMatch(/\*Warum jetzt:\* Personalengpass\./);
  expect(t).toMatch(/\*Angaben bei der Buchung:\*\nFläche in m²: ca\. 3\.000/);
  expect(t).toMatch(/• Aktueller Dienstleister\?\n• Vertragsende\?/);
});

test('formatBrief without AI: a factual brief from the data', () => {
  const t = B.formatBrief(null, lead, 'Fr 10:00', []);
  expect(t).toMatch(/\*Firma:\* Verwaltet 40 Wohnanlagen in Pankow\./);
  expect(t).toMatch(/\*Anlass:\* Sucht zwei Hausmeister\./);
  expect(t).not.toMatch(/Im Gespräch klären/);
  expect(B.formatBrief(null, {}, '', null)).toMatch(/Meeting-Briefing/);
});

test('meeting_brief validator', () => {
  const ok = (d) => V.validateByPrompt('meeting_brief', d).ok;
  expect(ok({ about: 'A', questions_to_ask: ['Q?'], why_now: '' })).toBe(true);
  expect(ok({ about: '', questions_to_ask: ['Q?'] })).toBe(false);
  expect(ok({ about: 'A', questions_to_ask: [] })).toBe(false);
  expect(ok({ about: 'A', questions_to_ask: ['Q'], why_now: 3 })).toBe(false);
  expect(ok(null)).toBe(false);
});

test('Calendly booking-form answers are read from webhook and poll payloads', () => {
  const p = C.parseCalendly({ event: 'invitee.created', payload: { email: 'A@b.de', questions_and_answers: [{ question: 'Fläche', answer: '3000' }, { question: 'x' }], scheduled_event: { uri: 'https://api/e/1' } } });
  expect(p.questions).toEqual([{ question: 'Fläche', answer: '3000' }]);
  expect(C.parseCalendly({ event: 'invitee.created', payload: { email: 'a@b.de' } }).questions).toEqual([]);
  const out = C.pollToPayloads([{ uri: 'e1', start_time: 'x' }], { e1: [{ email: 'a@b.de', created_at: new Date().toISOString(), questions_and_answers: [{ question: 'F', answer: '1' }] }] }, Date.now(), 30);
  expect(out[0].payload.questions_and_answers).toEqual([{ question: 'F', answer: '1' }]);
});
