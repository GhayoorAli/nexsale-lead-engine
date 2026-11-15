const V = require('../validators');
const F = require('../campaignFit');
const SM = require('../slackMessages');
const N = require('../notifications');
const CC = require('../controlCenter');

// real live case (Steuerberater Munich): the opening named only the district, the checker's own "issues" were empty
const seq = 'E-Mail 1\nBetreff: Reinigung für Ihre Kanzlei\nGuten Tag Marc Szackamer,\n\nDie Steuerkanzlei Marc Szackamer in München-Maxvorstadt bietet eine ganzheitliche Steuerberatung an.\n\nMein Name ist …';
const ctx = { summary: 'Die Steuerkanzlei befindet sich in München-Maxvorstadt und berät Unternehmen unterschiedlicher Rechtsformen, gegründet 1998.', sequence: seq,
  generic: ['Steuerberater', 'München-Maxvorstadt'], details: ['München-Maxvorstadt', 'Unternehmen unterschiedlicher Rechtsformen', 'gegründet 1998'] };
const weak = { opening_specific: true, opening_detail: 'München-Maxvorstadt', invented_claims: [], emails_with_company_detail: [1, 2], filler_phrases: [], issues: [], rewrite_hint: '' };

describe('rewrite feedback is computed in code (live: "Probleme: . Hinweis: .")', () => {
  test('a district alone is not a detail; the usable details are offered instead', () => {
    const f = V.qualityFeedback(weak, ctx);
    expect(f[0]).toMatch(/"München-Maxvorstadt" zählt nicht/);
    expect(f[0]).toMatch(/"Unternehmen unterschiedlicher Rechtsformen", "gegründet 1998"/);
    expect(f[0]).not.toMatch(/Beginne mit[^.]*"München-Maxvorstadt"/);
    expect(f[1]).toBe('E-Mail 3, 4 enthalten kein Detail der Firma: bringe in jede E-Mail ein anderes Detail aus der Beschreibung.');
  });
  test('invented claims, filler and the model\'s own notes are passed on; a good sequence gets no feedback', () => {
    const f = V.qualityFeedback({ ...weak, opening_detail: 'Unternehmen unterschiedlicher Rechtsformen', invented_claims: ['seit 50 Jahren'], filler_phrases: ['in Ihrer Branche'], issues: ['zu lang'], rewrite_hint: 'kürzer' }, {
      ...ctx, sequence: seq.replace('bietet eine ganzheitliche Steuerberatung an', 'berät Unternehmen unterschiedlicher Rechtsformen') });
    expect(f).toEqual(expect.arrayContaining([expect.stringMatching(/Streiche diese Aussagen.*"seit 50 Jahren"/), expect.stringMatching(/Floskeln: "in Ihrer Branche"/), 'zu lang', 'kürzer']));
    expect(f.some((x) => /erste Satz/.test(x))).toBe(false);
    const good = { opening_specific: true, opening_detail: 'gegründet 1998', invented_claims: [], emails_with_company_detail: [1, 2, 3, 4], filler_phrases: [], issues: [] };
    expect(V.qualityFeedback(good, { ...ctx, sequence: seq.replace('bietet eine ganzheitliche Steuerberatung an', 'wurde 1998 gegründet') })).toEqual([]);
  });
  test('no usable detail at all: tells the model what kind of detail to use', () => {
    expect(V.qualityFeedback(weak, { ...ctx, details: ['München-Maxvorstadt'] })[0]).toMatch(/Zahl, ein Gründungsjahr, eine Spezialisierung/);
  });
  test('marketing adjectives are not a detail (live: "ganzheitliche Steuerberatung" scored 90)', () => {
    const c = { summary: 'bietet eine ganzheitliche Steuerberatung für Unternehmen und Privatpersonen, spezialisiert auf Abfindungsberatung', generic: ['Steuerberater', 'München'] };
    expect(V.usableDetail('ganzheitliche Steuerberatung', c)).toBe(false);
    expect(V.usableDetail('Unternehmen und Privatpersonen', c)).toBe(false);
    expect(V.usableDetail('Abfindungsberatung', c)).toBe(true);
  });
  test('the opening sentence does not end at "Mr." or "z. B." (live: Mr. Cleaner was held for it)', () => {
    const sq = (t) => 'E-Mail 1\nBetreff: x\nGuten Tag Ismail Torah,\n\n' + t + '\n\nMein Name';
    expect(V.openingSentence(sq('Mr. Cleaner hat über 350.000 Kunden in 521 Städten. Das ist viel.'))).toBe('Mr. Cleaner hat über 350.000 Kunden in 521 Städten. ');
    expect(V.openingSentence(sq('Sie reinigen z. B. Praxen von Dr. Weber in Mitte. Zweiter Satz.'))).toBe('Sie reinigen z. B. Praxen von Dr. Weber in Mitte. ');
    expect(V.openingSentence(sq('Kein Punkt am Ende'))).toBe('Kein Punkt am Ende');
    const c = { summary: 'Mr. Cleaner hat über 350.000 zufriedene Kunden.', generic: ['Reinigungsunternehmen', 'Frankfurt'], sequence: sq('Mr. Cleaner betreut über 350.000 Kunden. Mehr.') };
    expect(V.verifiedOpening({ opening_specific: true, opening_detail: 'über 350.000 zufriedene Kunden' }, c)).toBe(true);
  });
  test('numbers count as details ("3.000 Wohneinheiten", founding year), short ones do not', () => {
    const c = { summary: 'Gegründet 1996, betreut rund 3.000 Wohneinheiten.', generic: ['Hausverwaltung', 'Berlin'] };
    expect(V.usableDetail('3.000 Wohneinheiten', c)).toBe(true);
    expect(V.usableDetail('seit 1996', c)).toBe(true);
    expect(V.usableDetail('15 Minuten', c)).toBe(false);
    expect(V.usableDetail('Berlin', c)).toBe(false);
  });
  test('validation errors become concrete fix instructions', () => {
    const h = V.fixHints(['step 1: filler phrase "Synergie"', 'step 1: filler phrase "Kernkompetenz"', 'step 4: filler phrase "beeindruckend"', 'step 1: body has 95 words (max 89)',
      'step 3: follow-up has 53 words (max 50)', 'step 2: no question (call to action) in the last paragraph', 'step 1: one block of text, needs at least 2 paragraphs',
      'step 1: subject has 7 words (max 5)', 'step 2: exclamation mark', 'AI output is not valid JSON', 'step 2: no question (call to action) in the last paragraph']);
    expect(h[0]).toMatch(/E-Mail 1: "Synergie" ist verboten – ersetze "Synergien besprechen"/);
    expect(h[1]).toMatch(/Ihr Tagesgeschäft/);
    expect(h[2]).toMatch(/E-Mail 4: .*kein Lob/);
    expect(h[3]).toBe('E-Mail 1 hat 95 Wörter (Grenze 89): kürze auf höchstens 75 Wörter, vor allem den Nutzen-Satz.');
    expect(h[4]).toBe('E-Mail 3 hat 53 Wörter: kürze auf höchstens 40 Wörter.');
    expect(h[5]).toMatch(/E-Mail 2: der letzte Absatz muss mit genau einer Frage enden/);
    expect(h[6]).toMatch(/3 kurze Absätze/);
    expect(h[7]).toMatch(/der Betreff hat 7 Wörter, höchstens 5/);
    expect(h[8]).toBe('E-Mail 2: keine Ausrufezeichen.');
    expect(h[9]).toBe('Die Antwort: AI output is not valid JSON');
    expect(h).toHaveLength(10); // duplicates removed
  });
  test('rewrite note: score, bullet list, the other rules still apply', () => {
    expect(V.rewriteNote(['A', 'B'], 55)).toBe('\nDie vorige Version wurde abgelehnt (Qualität 55/100, nötig 80). Schreibe die Sequenz neu und behebe genau diese Punkte:\n- A\n- B\nAlle anderen Regeln gelten weiter.');
    expect(V.rewriteNote(['A'])).toMatch(/^\nDie vorige Version wurde abgelehnt\. /);
  });
});

describe('campaign fit: client area and competitors (live: Real Service, Berlin only, ran München and Frankfurt)', () => {
  const rs = { name: 'Real Service GmbH', service_area: 'Berlin, Potsdam', industry: 'Gebäudereinigung' };
  test('outside the service area → warning; inside, districts and English names fit', () => {
    expect(F.campaignFit({ city: 'Munich', industry: 'Steuerberater' }, rs)).toEqual(['Die Stadt "Munich" liegt nicht im Einsatzgebiet von Real Service GmbH (Berlin, Potsdam). Die E-Mails bieten dann etwas an, das der Client dort nicht liefert.']);
    expect(F.campaignFit({ city: 'Berlin', industry: 'Hausverwaltung' }, rs)).toEqual([]);
    expect(F.campaignFit({ city: 'Berlin-Pankow', industry: 'Hausverwaltung' }, rs)).toEqual([]);
    expect(F.campaignFit({ city: 'potsdam', industry: 'Hausverwaltung' }, rs)).toEqual([]);
    expect(F.campaignFit({ city: 'München', industry: 'Steuerberater' }, { name: 'X', service_area: 'Munich' })).toEqual([]);
    expect(F.campaignFit({ city: 'Frankfurt am Main', industry: 'Hotel' }, { name: 'X', service_area: 'Frankfurt' })).toEqual([]);
  });
  test('no area or "bundesweit" = everywhere (Nexsale works nationwide)', () => {
    expect(F.campaignFit({ city: 'Leipzig', industry: 'Hotel' }, { name: 'Nexsale GmbH' })).toEqual([]);
    expect(F.campaignFit({ city: 'Leipzig', industry: 'Hotel' }, { name: 'N', service_area: 'bundesweit' })).toEqual([]);
  });
  test('the client\'s own industry → competitor warning', () => {
    const w = F.campaignFit({ city: 'Berlin', industry: 'Reinigungsunternehmen' }, rs);
    expect(w).toEqual(['Die Branche "Reinigungsunternehmen" ist die eigene Branche von Real Service GmbH (Gebäudereinigung): Sie würden Wettbewerber anschreiben.']);
    expect(F.sameIndustry('Steuerberater', 'Steuerberatung')).toBe(true);
    expect(F.sameIndustry('Hausverwaltung', 'Gebäudereinigung')).toBe(false);
    expect(F.sameIndustry('Facility Management', 'Property Management')).toBe(false);
    expect(F.campaignFit({ city: 'Frankfurt am Main', industry: 'Reinigungsunternehmen' }, rs)).toHaveLength(2);
    expect(F.campaignFit(null, null)).toEqual([]);
  });
  test('warnings appear in Slack "Campaign ready" and in the internal email', () => {
    const w = F.campaignFit({ city: 'Munich', industry: 'Steuerberater' }, rs);
    const m = SM.campaignReady({ name: 'C', campaignRecordId: 'r', warnings: w });
    expect(JSON.stringify(m.blocks)).toMatch(/Check before launch:\*\\n• Die Stadt \\"Munich\\"/);
    expect(JSON.stringify(SM.campaignReady({ name: 'C', campaignRecordId: 'r' }).blocks)).not.toMatch(/Check before launch/);
    const e = N.campaignReadyEmail({ name: 'C', warnings: w });
    expect(e.body).toMatch(/ACHTUNG vor dem Start:\n- Die Stadt "Munich"/);
    expect(e.html).toMatch(/Achtung vor dem Start:<\/b><br>Die Stadt &quot;Munich&quot;/);
    expect(N.campaignReadyEmail({ name: 'C' }).html).not.toMatch(/Achtung/);
  });
  test('Control Center: warning on the campaign page, in the list, after creating; the client form has the fields', () => {
    const data = { clients: [{ id: 'cR', ...rs }], campaigns: [{ id: 'k1', name: 'Steuer München', client: ['cR'], client_record_id: 'cR', status: 'Ready', industry: 'Steuerberater', city: 'Munich' }],
      leads: [], emails: [], replies: [], meetings: [], tasks: [], logs: [] };
    const r = (page, params) => CC.renderPage({ page, params: params || {}, data, cfg: {}, now: '2026-11-15T12:00:00Z', user: 'admin' });
    expect(r('campaign', { id: 'k1' })).toMatch(/flash bad">Achtung: Die Stadt &quot;Munich&quot; liegt nicht im Einsatzgebiet/);
    expect(r('campaigns')).toMatch(/passt nicht zum Client/);
    expect(r('new-campaign')).toMatch(/<b>Real Service GmbH<\/b>: Berlin, Potsdam · eigene Branche Gebäudereinigung/);
    expect(r('client', { id: 'cR' })).toMatch(/name="service_area"/);
    expect(r('client', { id: 'cR' })).toMatch(/name="industry"/);
    const p = CC.planAction({ action: 'campaign_create', name: 'X', client: 'Real Service GmbH', industry: 'Reinigungsunternehmen', city: 'Berlin', company_size: '10-49', target_role: 'Geschäftsführer', max_leads: '10' }, data, { user: 'admin', defaultMax: 10 });
    expect(p.ops).toHaveLength(1);
    expect(p.warnings[0]).toMatch(/Wettbewerber/);
    expect(decodeURIComponent(p.redirect)).toMatch(/Kampagne angelegt\. Achtung: .*Wettbewerber/);
    expect(p.redirect).toMatch(/err=1/);
  });
});

describe('the opening is verified against every real detail, not only the checker\'s quote (Fix A)', () => {
  // live case: second version of Mr. Cleaner scored 55 although it opened with "Seit 2006"
  const summary = 'Mr. Cleaner bietet seit 2006 professionelle Reinigungsdienstleistungen in über 521 Städten in Deutschland, Österreich und der Schweiz an. Das Unternehmen hat über 350.000 zufriedene Kunden und organisiert einmalige Reinigungen für Privatkunden ohne vertragliche Bindung.';
  const sq = (t) => 'E-Mail 1\nBetreff: x\nGuten Tag Ismail Torah,\n\n' + t + '\n\nMein Name ist Laura Schmidt.';
  const ctx = (opening, details) => ({ summary, sequence: sq(opening), generic: ['Reinigungsunternehmen', 'Frankfurt am Main'], details: details || [] });
  const checker = { opening_specific: true, opening_detail: 'professionelle Reinigungsdienstleistungen', invented_claims: [], emails_with_company_detail: [1, 4], filler_phrases: [] };
  test('the live case: a number from the description in the opening counts, even if the checker quoted something generic', () => {
    const c = ctx('Seit 2006 bietet Mr. Cleaner professionelle Reinigungsdienstleistungen an und hat sich damit einen großen Kundenstamm aufgebaut.');
    expect(V.openingDetail(checker, c)).toBe('2006');
    expect(V.qualityScore(checker, c)).toBe(35 + 35 + 10 + 10);
  });
  test('the writer\'s own detail counts when 2 of its words are in the opening', () => {
    const c = ctx('Mr. Cleaner organisiert einmalige Reinigungen für Privatkunden ohne Vertrag.', ['einmalige Reinigungen für Privatkunden ohne vertragliche Bindung']);
    expect(V.openingDetail({ ...checker, opening_specific: false }, c)).toMatch(/einmalige Reinigungen/);
  });
  test('still strict: generic openings, details only in a later sentence, invented numbers and short numbers fail', () => {
    expect(V.verifiedOpening(checker, ctx('Mr. Cleaner bietet professionelle Reinigungsdienstleistungen in Frankfurt am Main an. Seit 2006 am Markt.'))).toBe(false);
    expect(V.verifiedOpening(checker, ctx('Mr. Cleaner hat über 900 Mitarbeiter.'))).toBe(false); // 900 is not in the description
    expect(V.verifiedOpening(checker, ctx('Mr. Cleaner bietet Reinigung in 15 Minuten an.'))).toBe(false);
    expect(V.verifiedOpening(checker, ctx('Mr. Cleaner bietet Reinigung an.', ['professionelle Reinigungsdienstleistungen', 'Frankfurt am Main']))).toBe(false);
    expect(V.verifiedOpening({ ...checker, opening_detail: 'Unternehmen wie Ihres' }, ctx('Unternehmen wie Ihres profitieren von uns.'))).toBe(false);
  });
  test('the feedback no longer complains about an opening that has a verified number', () => {
    const c = ctx('Seit 2006 bietet Mr. Cleaner professionelle Reinigungsdienstleistungen an.');
    expect(V.qualityFeedback(checker, c).some((x) => /erste Satz/.test(x))).toBe(false);
  });
  test('without a context the checker\'s answer decides (unchanged)', () => {
    expect(V.verifiedOpening({ opening_specific: true }, null)).toBe(true);
    expect(V.verifiedOpening({ opening_specific: false }, null)).toBe(false);
  });
});

test('"… an." / "… zu." end a sentence; "z. B.", "Dr.", "Nr." do not (opening and paragraph split)', () => {
  const VE = require('../validateEmails');
  const sq = (t) => 'E-Mail 1\nBetreff: x\nGuten Tag,\n\n' + t + '\n\nMein Name';
  expect(V.openingSentence(sq('Sie bieten Reinigung in Frankfurt an. Seit 2006 am Markt.'))).toBe('Sie bieten Reinigung in Frankfurt an. ');
  expect(V.openingSentence(sq('Sie reinigen z. B. Praxen von Dr. Weber, Haus Nr. 5. Zweiter Satz.'))).toBe('Sie reinigen z. B. Praxen von Dr. Weber, Haus Nr. 5. ');
  const t = 'Sie betreuen rund 2.000 Wohnungen in Pankow und bieten dort auch eigene Hausmeisterdienste für Mieter an. Mein Name ist Laura Schmidt, wir reinigen Treppenhäuser mit festen Teams und dokumentierter Qualitätskontrolle zu. Passt Ihnen ein kurzes Telefonat von 15 Minuten in der nächsten Woche?';
  expect(VE.formatParagraphs(t).split('\n\n')).toHaveLength(3);
});
