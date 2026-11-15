const S = require('../score');

const full = { contact_name: 'Thomas Becker', email: 't.becker@a.de', mx_ok: true, google_rating: 4.0, review_count: 20, hiring_signal: true };

describe('scoreLead', () => {
  test('all rules give 100', () => expect(S.scoreLead(full).score).toBe(100));
  test.each([
    ['contact_name', null, 70],
    ['email', 'info@a.de', 80],
    ['mx_ok', false, 85],
    ['google_rating', 3.99, 90],
    ['review_count', 19, 90],
    ['hiring_signal', false, 85],
  ])('without %s', (field, value, score) => {
    expect(S.scoreLead(Object.assign({}, full, { [field]: value })).score).toBe(score);
  });
  test('missing fields give 0, never NaN', () => {
    expect(S.scoreLead({}).score).toBe(0);
    expect(S.scoreLead(undefined).score).toBe(0);
    expect(S.scoreLead({ google_rating: '4.5', review_count: 'abc' }).score).toBe(0);
  });
  test('breakdown is returned', () => {
    expect(S.scoreLead(full).breakdown).toEqual({ director: 30, personalEmail: 20, mx: 15, rating: 10, reviews: 10, hiring: 15 });
  });
});

describe('decideStatus boundary 49 vs 50', () => {
  test('50 with email is Enriched', () => expect(S.decideStatus({ email: 'a@b.de', mx_ok: true }, 50).status).toBe('Enriched'));
  test('49 is Rejected with reason', () => {
    const r = S.decideStatus({ email: 'a@b.de' }, 49);
    expect(r.status).toBe('Rejected');
    expect(r.reason).toMatch(/49 below 50/);
  });
  test('no email is Rejected', () => expect(S.decideStatus({}, 100)).toEqual({ status: 'Rejected', reason: 'no email found in Impressum' }));
  test('no MX is Rejected', () => expect(S.decideStatus({ email: 'a@b.de', mx_ok: false }, 90).reason).toMatch(/MX/));
  test('null lead', () => expect(S.decideStatus(null, 90).status).toBe('Rejected'));
});

test('isPersonalEmail', () => {
  expect(S.isPersonalEmail('t.becker@a.de')).toBe(true);
  expect(S.isPersonalEmail('info@a.de')).toBe(false);
  expect(S.isPersonalEmail('kontakt@a.de')).toBe(false);
  expect(S.isPersonalEmail('')).toBe(false);
  expect(S.isPersonalEmail('123@a.de')).toBe(false);
});

test('one person, one sequence: duplicate emails are rejected', () => {
  const ups = [
    { id: 'A', fields: { email: 'info@putz.de', status: 'Enriched', company_name: 'Putz A' } },
    { id: 'B', fields: { email: 'INFO@putz.de', status: 'Enriched' } },
    { id: 'C', fields: { email: 'x@other.de', status: 'Enriched' } },
    { id: 'D', fields: { email: '', status: 'Rejected' } },
    { id: 'E', fields: { email: 'old@known.de', status: 'Enriched' } },
    { id: 'F', fields: { email: 'r@r.de', status: 'Rejected' } },
  ];
  const out = S.markDuplicateEmails(ups, [{ id: 'Z', email: 'old@known.de', company_name: 'Known GmbH' }, { id: 'C', email: 'x@other.de' }, { id: 'N' }]);
  expect(out.map((u) => u.fields.status)).toEqual(['Enriched', 'Rejected', 'Enriched', 'Rejected', 'Rejected', 'Rejected']);
  expect(out[1].fields.reject_reason).toBe('duplicate contact: same person as Putz A');
  expect(out[4].fields.reject_reason).toMatch(/Known GmbH/);
  expect(S.markDuplicateEmails()).toEqual([]);
});

test('same director at the same address (two brand websites) is one person', () => {
  const ups = [
    { id: 'P1', company_name: 'PutzProfis', address: 'Kollwitzstraße 76, 10435 Berlin', phone: '01577 111', fields: { email: 'info@putzprofis.example', contact_name: 'Luan Muster', status: 'Enriched' } },
    { id: 'P2', company_name: 'PutzHelden', address: 'Kollwitzstraße  76, 10435 Berlin', phone: '030 222', fields: { email: 'info@putzhelden.example', contact_name: 'Luan Muster', status: 'Enriched' } },
    { id: 'P3', company_name: 'Other', address: 'Anderswo 1', phone: '+49 30 222', fields: { email: 'x@o.example', contact_name: 'Luan Muster', status: 'Enriched' } },
    { id: 'P4', company_name: 'Namesake', address: 'Weit weg 9', phone: '040 999', fields: { email: 'y@n.example', contact_name: 'Luan Muster', status: 'Enriched' } },
    { id: 'P5', company_name: 'NoName', address: 'Kollwitzstraße 76, 10435 Berlin', fields: { email: 'z@n.example', contact_name: '', status: 'Enriched' } },
  ];
  const out = S.markDuplicateContacts(ups, []);
  expect(out.map((u) => u.fields.status)).toEqual(['Enriched', 'Rejected', 'Rejected', 'Enriched', 'Enriched']);
  expect(out[1].fields.reject_reason).toBe('duplicate contact: same person as PutzProfis'); // same name + address
  expect(out[2].fields.reject_reason).toMatch(/PutzProfis/); // same name + phone as P2 (030 222 = +49 30 222), P2 = P1 → points to the first
  expect(S.contactKeys({ contact_name: 'A B', phone: '12' })).toEqual([]); // too short to be a phone
});
