/**
 * schedule.js – send timing in Europe/Berlin without external libraries.
 * Steps 1–4 go out on day 0, 3, 7, 14 counted from the first send.
 * Real mode: only Mon–Fri 08:00–17:00 Berlin time (weekends skipped).
 * DEMO_MODE: days become minutes and the send window is ignored.
 */
const STEP_OFFSETS = { 1: 0, 2: 3, 3: 7, 4: 14 };
const TZ = 'Europe/Berlin';
const WINDOW = { startHour: 8, endHour: 17 };
const WEEKDAYS = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

function berlinParts(date) {
  const d = new Date(date);
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short', hourCycle: 'h23',
  });
  const p = {};
  fmt.formatToParts(d).forEach((x) => (p[x.type] = x.value));
  return {
    year: +p.year, month: +p.month, day: +p.day, hour: +p.hour, minute: +p.minute, second: +p.second, weekday: WEEKDAYS[p.weekday],
  };
}

/** Converts a Berlin wall-clock time to a UTC Date (handles DST). */
function berlinToUtc(year, month, day, hour, minute) {
  let guess = Date.UTC(year, month - 1, day, hour, minute || 0);
  for (let i = 0; i < 2; i++) {
    const p = berlinParts(guess);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    const offset = asUtc - guess;
    guess = Date.UTC(year, month - 1, day, hour, minute || 0) - offset;
  }
  return new Date(guess);
}

function isSendWindow(date) {
  const p = berlinParts(date);
  return p.weekday <= 5 && p.hour >= WINDOW.startHour && p.hour < WINDOW.endHour;
}

/** The given time if it is inside the send window, else the next weekday 08:00 Berlin. */
function nextSendSlot(date, opts) {
  const d = new Date(date);
  if (opts && opts.demoMode) return d;
  if (isSendWindow(d)) return d;
  let p = berlinParts(d);
  // start from today 08:00 if before the window on a weekday, else move day by day
  let cand = berlinToUtc(p.year, p.month, p.day, WINDOW.startHour, 0);
  if (cand <= d) {
    const next = new Date(Date.UTC(p.year, p.month - 1, p.day + 1, 12));
    p = berlinParts(next);
    cand = berlinToUtc(p.year, p.month, p.day, WINDOW.startHour, 0);
  }
  for (let i = 0; i < 7 && berlinParts(cand).weekday > 5; i++) {
    const q = berlinParts(cand);
    const next = new Date(Date.UTC(q.year, q.month - 1, q.day + 1, 12));
    const r = berlinParts(next);
    cand = berlinToUtc(r.year, r.month, r.day, WINDOW.startHour, 0);
  }
  return cand;
}

/** When step `step` is due, counted from the first send. */
function sendAtForStep(firstSentAt, step, opts) {
  const offset = STEP_OFFSETS[step];
  if (offset === undefined) throw new Error('unknown step ' + step);
  const first = new Date(firstSentAt);
  if (opts && opts.demoMode) return new Date(first.getTime() + offset * 60 * 1000);
  const p = berlinParts(first);
  const target = berlinToUtc(p.year, p.month, p.day + offset, p.hour, p.minute);
  return nextSendSlot(target, opts);
}

/** Wait between two sends: 60–180 s real, 2–5 s demo, 0 when mocked. */
function randomDelaySeconds(opts, rand) {
  const r = typeof rand === 'number' ? rand : Math.random();
  if (opts && opts.mock) return 0;
  if (opts && opts.demoMode) return 2 + Math.round(r * 3);
  return 60 + Math.round(r * 120);
}

/** Berlin calendar date "YYYY-MM-DD" (for daily counters). */
function berlinDate(date) {
  const p = berlinParts(date);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

function addDays(date, days) {
  return new Date(new Date(date).getTime() + days * 86400000);
}

const scheduleApi = { STEP_OFFSETS, berlinParts, berlinToUtc, isSendWindow, nextSendSlot, sendAtForStep, randomDelaySeconds, berlinDate, addDays };
if (typeof module !== 'undefined' && module.exports) module.exports = scheduleApi;
