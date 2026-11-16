
describe('HubSpot race safety (live: two syncs 0.4 s apart → "Contact already exists")', () => {
  const C = require('../crm');
  test('upsertId: created/updated object, 409 with the existing id, any other error', () => {
    expect(C.upsertId({ id: 925, properties: {} })).toEqual({ id: '925', conflict: false });
    expect(C.upsertId({ status: 'error', message: 'Contact already exists. Existing ID: 925138341073', category: 'CONFLICT' })).toEqual({ id: '925138341073', conflict: true });
    const e = C.upsertId({ status: 'error', message: 'Property values were not valid', category: 'VALIDATION_ERROR' });
    expect(e.id).toBeNull();
    expect(e.error).toMatch(/Property values were not valid/);
    expect(C.upsertId(null).id).toBeNull();
  });
  test('knownId: the id saved in Airtable wins over the search (no search-index delay)', () => {
    expect(C.knownId('925', { results: [{ id: '1' }] })).toBe('925');
    expect(C.knownId('', { results: [{ id: '1' }] })).toBe('1');
    expect(C.knownId(undefined, { results: [] })).toBeNull();
    expect(C.knownId('../x', { results: [] })).toBeNull(); // only numeric ids are used in a path
  });
  test('syncFormula: the 15-minute run skips leads changed in the last 3 minutes; the event run does not', () => {
    expect(C.syncFormula(true)).toMatch(/IS_BEFORE\(LAST_MODIFIED_TIME\(\),DATEADD\(NOW\(\),-3,'minutes'\)\)\)$/);
    expect(C.syncFormula(false)).not.toMatch(/LAST_MODIFIED_TIME/);
    expect(C.syncFormula(false)).toMatch(/^AND\(OR\(\{status\}='Interested'.*\{crm_synced_status\}!=\{status\}\)$/);
  });
});

describe('per-lead lock: two runs never sync the same lead at once', () => {
  const C = require('../crm');
  const now = '2026-11-15T20:30:45.000Z';
  test('event run syncs only its own lead; ids are checked before use in a formula', () => {
    expect(C.syncFormula(false, 'rec5H6qC87C85pq5P')).toMatch(/^AND\(RECORD_ID\(\)='rec5H6qC87C85pq5P',OR\(/);
    expect(C.syncFormula(false, "x' OR 1")).not.toMatch(/RECORD_ID/);
    expect(C.syncFormula(true, 'rec5H6qC87C85pq5P')).not.toMatch(/RECORD_ID/); // the schedule never narrows
  });
  test('claim: free and stale-locked leads are claimed; a lead locked by another live run is left alone', () => {
    const leads = [{ id: 'recA' }, { id: 'recB', crm_lock: 'crm-9', crm_lock_at: '2026-11-15T20:30:40.000Z' },
      { id: 'recC', crm_lock: 'crm-8', crm_lock_at: '2026-11-15T20:20:00.000Z' }, { id: 'recD', crm_lock: 'crm-1', crm_lock_at: now }];
    const c = C.lockClaim(leads, 'crm-1', now);
    expect(c.ids).toEqual(['recA', 'recC', 'recD']);
    expect(c.records[0]).toEqual({ id: 'recA', fields: { crm_lock: 'crm-1', crm_lock_at: now } });
    expect(C.lockClaim(null, 'crm-1', now).ids).toEqual([]);
    expect(C.lockFree({ crm_lock: 'crm-9' }, 'crm-1', now)).toBe(true); // no timestamp → treated as stale
  });
  test('read back: only the leads that still carry this run\'s id (Airtable keeps the last write → one winner)', () => {
    const back = [{ id: 'recA', fields: { crm_lock: 'crm-2' } }, { id: 'recC', fields: { crm_lock: 'crm-1' } }, null, { id: 'recX' }];
    expect(C.lockedByMe(back, 'crm-1').map((r) => r.id)).toEqual(['recC']);
    expect(C.lockedByMe(back, 'crm-2').map((r) => r.id)).toEqual(['recA']);
  });
});

test('the company HubSpot attached to a new contact is used (live: every synced lead had two companies)', () => {
  const C = require('../crm');
  expect(C.associatedId({ results: [{ toObjectId: 467587413212, associationTypes: [] }] })).toBe('467587413212');
  expect(C.associatedId({ results: [] })).toBeNull();
  expect(C.associatedId({ status: 'error' })).toBeNull();
  // order: saved id → HubSpot's linked company → domain search
  expect(C.knownId('11', { results: [{ id: '33' }] }, '22')).toBe('11');
  expect(C.knownId('', { results: [{ id: '33' }] }, '22')).toBe('22');
  expect(C.knownId('', { results: [{ id: '33' }] }, null)).toBe('33');
});
