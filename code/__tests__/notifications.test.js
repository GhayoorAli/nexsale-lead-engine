const N = require('../notifications');

const c = { name: 'Hausverwaltungen Berlin', client: 'Real Service GmbH', sender: 'Laura Schmidt, Real Service GmbH', leadCount: 4, avgScore: 65, avgQuality: 92, flagged: 1, rejected: 3,
  controlUrl: 'http://localhost:5678/webhook/app?p=campaign&id=rec1',
  samples: [{ company: 'KURTZKE <Immobilien>', score: 65, quality: 90, subject: 'Reinigung für Pankow', body: 'Guten Tag Sven Kurtzke,\n\nAbsatz eins.\n\nAbsatz zwei?\n\nMit freundlichen Grüßen\n\nLaura Schmidt\n-- \nReal Service GmbH · Berlin\nAntworten Sie mit STOP' }] };

test('subject without [TEST], clear German wording', () => {
  const m = N.campaignReadyEmail(c);
  expect(m.subject).toBe('Kampagne bereit: Hausverwaltungen Berlin');
  expect(m.subject).not.toMatch(/TEST/);
});

test('plain text: facts, the sample with its paragraphs, no legal footer, next step with the link', () => {
  const t = N.campaignReadyEmail(c).body;
  expect(t).toMatch(/^Guten Tag,\n\ndie Kampagne "Hausverwaltungen Berlin" ist bereit zum Start\./);
  expect(t).toMatch(/Client: Real Service GmbH\nAbsender: Laura Schmidt, Real Service GmbH\nFreigegebene Leads: 4/);
  expect(t).toMatch(/Absatz eins\.\n\nAbsatz zwei\?/);
  expect(t).not.toMatch(/Antworten Sie mit STOP/);
  expect(t).toMatch(/http:\/\/localhost:5678\/webhook\/app\?p=campaign&id=rec1/);
  expect(t).not.toMatch(/\n\n\n/);
});

test('HTML: escaped, paragraphs kept (pre-wrap), button to the Control Center', () => {
  const h = N.campaignReadyEmail(c).html;
  expect(h).toMatch(/KURTZKE &lt;Immobilien&gt;/);
  expect(h).not.toMatch(/KURTZKE <Immobilien>/);
  expect(h).toMatch(/white-space:pre-wrap/);
  expect(h).toMatch(/href="http:\/\/localhost:5678\/webhook\/app\?p=campaign&amp;id=rec1"/);
  expect(h).toMatch(/Interne Benachrichtigung/);
});

test('works without samples or link', () => {
  const m = N.campaignReadyEmail({ name: 'X' });
  expect(m.body).toMatch(/im Control Center\./);
  expect(m.html).not.toMatch(/Im Control Center öffnen/);
  expect(N.campaignReadyEmail().subject).toBe('Kampagne bereit: ');
  expect(N.withoutFooter('a\n-- \nb')).toBe('a');
});
