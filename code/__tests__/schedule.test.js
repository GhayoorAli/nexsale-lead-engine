const S = require('../schedule');

// 2026-11-16 is a Monday. Berlin is UTC+1 in November (CET).
const MON_10 = '2026-11-16T09:00:00.000Z'; // 10:00 Berlin

describe('step dates day 0, 3, 7, 14', () => {
  test('real mode: Monday 10:00 first send', () => {
    expect(S.sendAtForStep(MON_10, 1).toISOString()).toBe(MON_10);
    expect(S.sendAtForStep(MON_10, 2).toISOString()).toBe('2026-11-19T09:00:00.000Z'); // Thu
    expect(S.sendAtForStep(MON_10, 3).toISOString()).toBe('2026-11-23T09:00:00.000Z'); // Mon
    expect(S.sendAtForStep(MON_10, 4).toISOString()).toBe('2026-11-30T09:00:00.000Z'); // Mon
  });
  test('weekends are skipped: Thursday + 3 days = Sunday -> Monday 08:00', () => {
    const thu = '2026-11-19T13:00:00.000Z'; // Thu 14:00 Berlin
    expect(S.sendAtForStep(thu, 2).toISOString()).toBe('2026-11-23T07:00:00.000Z'); // Mon 08:00 Berlin
  });
  test('DEMO_MODE uses minutes instead of days', () => {
    const o = { demoMode: true };
    expect(S.sendAtForStep(MON_10, 2, o).toISOString()).toBe('2026-11-16T09:03:00.000Z');
    expect(S.sendAtForStep(MON_10, 3, o).toISOString()).toBe('2026-11-16T09:07:00.000Z');
    expect(S.sendAtForStep(MON_10, 4, o).toISOString()).toBe('2026-11-16T09:14:00.000Z');
  });
  test('unknown step throws', () => expect(() => S.sendAtForStep(MON_10, 5)).toThrow(/unknown step/));
});

describe('send window 08:00–17:00 Berlin, Mon–Fri', () => {
  test.each([
    ['2026-11-16T07:00:00.000Z', true], // Mon 08:00
    ['2026-11-16T06:59:00.000Z', false], // Mon 07:59
    ['2026-11-16T15:59:00.000Z', true], // Mon 16:59
    ['2026-11-16T16:00:00.000Z', false], // Mon 17:00
    ['2026-11-21T10:00:00.000Z', false], // Saturday
    ['2026-07-06T06:30:00.000Z', true], // summer (CEST): Mon 08:30
  ])('%s -> %p', (iso, ok) => expect(S.isSendWindow(iso)).toBe(ok));

  test('nextSendSlot: evening -> next morning 08:00', () => {
    expect(S.nextSendSlot('2026-11-16T18:00:00.000Z').toISOString()).toBe('2026-11-17T07:00:00.000Z');
  });
  test('nextSendSlot: early morning -> same day 08:00', () => {
    expect(S.nextSendSlot('2026-11-17T05:00:00.000Z').toISOString()).toBe('2026-11-17T07:00:00.000Z');
  });
  test('nextSendSlot: Friday evening -> Monday 08:00', () => {
    expect(S.nextSendSlot('2026-11-20T17:30:00.000Z').toISOString()).toBe('2026-11-23T07:00:00.000Z');
  });
  test('nextSendSlot: Saturday morning -> Monday 08:00', () => {
    expect(S.nextSendSlot('2026-11-21T05:00:00.000Z').toISOString()).toBe('2026-11-23T07:00:00.000Z');
  });
  test('nextSendSlot inside window returns same time; demo returns now', () => {
    expect(S.nextSendSlot(MON_10).toISOString()).toBe(MON_10);
    expect(S.nextSendSlot('2026-11-21T05:00:00.000Z', { demoMode: true }).toISOString()).toBe('2026-11-21T05:00:00.000Z');
  });
});

test('berlinToUtc handles summer and winter time', () => {
  expect(S.berlinToUtc(2026, 7, 1, 8, 0).toISOString()).toBe('2026-07-01T06:00:00.000Z');
  expect(S.berlinToUtc(2026, 12, 1, 8, 0).toISOString()).toBe('2026-12-01T07:00:00.000Z');
});

test('randomDelaySeconds', () => {
  expect(S.randomDelaySeconds({}, 0)).toBe(60);
  expect(S.randomDelaySeconds({}, 1)).toBe(180);
  expect(S.randomDelaySeconds({ demoMode: true }, 0.5)).toBeGreaterThanOrEqual(2);
  expect(S.randomDelaySeconds({ mock: true })).toBe(0);
  const r = S.randomDelaySeconds({});
  expect(r).toBeGreaterThanOrEqual(60);
  expect(r).toBeLessThanOrEqual(180);
});

test('berlinDate and addDays', () => {
  expect(S.berlinDate('2026-11-16T23:30:00.000Z')).toBe('2026-11-17');
  expect(S.addDays('2026-11-16T00:00:00.000Z', 2).toISOString()).toBe('2026-11-18T00:00:00.000Z');
});
