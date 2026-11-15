const fs = require('fs');
const path = require('path');
const R = require('../replies');

const DIR = path.join(__dirname, '../../tests/fixtures/replies');
const load = (k) => JSON.parse(fs.readFileSync(path.join(DIR, k + '.json'), 'utf8'));
const NOW = '2026-11-14T10:00:00.000Z';
const cfg = { autoReplyMinConfidence: 0.85, unsureConfidence: 0.7 };

describe('normaliseIncoming', () => {
  test('Gmail trigger shape', () => {
    const r = R.normaliseIncoming({ id: 'm1', threadId: 't1', from: { value: [{ address: 'A@B.de' }] }, subject: 'Re: x', text: 'Hallo\n\nAm Mo. schrieb X:\n> alt', date: NOW, headers: { 'auto-submitted': 'auto-replied' } });
    expect(r).toMatchObject({ message_id: 'm1', thread_id: 't1', from_email: 'a@b.de', body_clean: 'Hallo', auto_submitted: 'auto-replied', received_at: NOW });
  });
  test('header names are case-insensitive', () => {
    expect(R.normaliseIncoming({ from: 'a@b.de', headers: { 'Auto-Submitted': 'auto-replied', Subject: 'Abwesend' } })).toMatchObject({ auto_submitted: 'auto-replied', subject: 'Abwesend' });
  });
  test('webhook shape and string from', () => {
    const r = R.normaliseIncoming({ message_id: 'm', thread_id: 't', from: 'Max <max@firma.de>', body: 'text\n-----Ursprüngliche Nachricht-----\nalt', received_at: NOW });
    expect(r.from_email).toBe('max@firma.de');
    expect(r.body_clean).toBe('text');
    expect(R.normaliseIncoming(undefined).from_email).toBe('');
  });
  test('addr variants', () => {
    expect(R.addr({ address: 'X@Y.de' })).toBe('x@y.de');
    expect(R.addr({ text: 'N <n@y.de>' })).toBe('n@y.de');
    expect(R.addr(null)).toBe('');
  });
  test('stripQuoted handles On ... wrote', () => expect(R.stripQuoted('Yes\nOn Mon, X wrote:\n> old')).toBe('Yes'));
});

describe('newsletters and notifications', () => {
  test.each([
    [{ from: 'onboarding@crm.example', subject: 'Welcome' }, true],
    [{ from: 'Max <noreply@shop.example>' }, true],
    [{ from: 'news@x.example' }, true],
    [{ from: 'a@b.example', headers: { 'list-unsubscribe': '<mailto:u@b.example>' } }, true],
    [{ from: 'a@b.example', headers: { Precedence: 'bulk' } }, true],
    [{ from: 'a@b.example', bulk: true }, true],
    [{ from: 'thomas.becker@firma.example', subject: 'Re: Termin' }, false],
    [{ from: 'info@firma.example' }, false],
  ])('%j -> %p', (msg, bulk) => expect(R.normaliseIncoming(msg).bulk).toBe(bulk));
});

describe('bounces', () => {
  test('mailer-daemon is a bounce and the address is extracted', () => {
    const b = R.normaliseIncoming(load('bounce_01'));
    b.from_email = 'mailer-daemon@googlemail.com';
    expect(R.detectBounce(b)).toBe(true);
    expect(R.bouncedAddress(b)).toBe('t.becker@glanzwerk-berlin.example');
  });
  test('subject based detection; normal reply is not a bounce', () => {
    expect(R.detectBounce({ from_email: 'x@y.de', subject: 'Unzustellbar: Ihre Nachricht' })).toBe(true);
    expect(R.detectBounce({ from_email: 'x@y.de', subject: 'Re: Hallo' })).toBe(false);
    expect(R.bouncedAddress({ body: 'nothing' })).toBe('');
  });
});

describe('rule pre-classification', () => {
  test('STOP is Unsubscribe with confidence 1', () => expect(R.ruleClassify(R.normaliseIncoming(load('tricky_stop')))).toMatchObject({ category: 'Unsubscribe', confidence: 1 }));
  test.each(['ooo_01', 'ooo_02'])('%s is Out of office with a return date', (k) => {
    const r = R.ruleClassify(R.normaliseIncoming(load(k)), NOW);
    expect(r.category).toBe('Out of office');
    expect(r.return_date).toMatch(/^2026-1[12]-\d\d$/);
  });
  test.each(['unsubscribe_01', 'unsubscribe_02'])('%s is Unsubscribe', (k) => expect(R.ruleClassify(R.normaliseIncoming(load(k))).category).toBe('Unsubscribe'));
  test.each(['interested_01', 'interested_02', 'later_01', 'later_02', 'not_interested_01', 'not_interested_02', 'tricky_english', 'unclear_01'])('%s goes to the AI', (k) => {
    expect(R.ruleClassify(R.normaliseIncoming(load(k)), NOW)).toBeNull();
  });
});

describe('findReturnDate', () => {
  test.each([
    ['ab 2026-12-01', '2026-12-01'],
    ['bis 24.11.2026', '2026-11-24'],
    ['bis 24.11.26', '2026-11-24'],
    ['bis 03.01.', '2027-01-03'],
    ['am 20.11.', '2026-11-20'],
    ['bis 45.13.2026', null],
    ['nichts', null],
  ])('%s', (t, d) => expect(R.findReturnDate(t, NOW)).toBe(d));
  test('default now', () => expect(R.findReturnDate('2030-01-01')).toBe('2030-01-01'));
});

describe('matchReplyToLead', () => {
  const leads = [{ id: 'L1', email: 'a@firma.de' }, { id: 'L2', email: 'b@firma2.de' }];
  const emails = [{ lead: ['L2'], thread_id: 'T2' }, { lead_record_id: 'L1', thread_id: 'T9' }];
  test('thread id first', () => expect(R.matchReplyToLead({ thread_id: 'T2', from_email: 'a@firma.de' }, leads, emails)).toEqual({ lead: leads[1], by: 'thread_id' }));
  test('then from_email', () => expect(R.matchReplyToLead({ thread_id: 'TX', from_email: 'A@firma.de' }, leads, emails).by).toBe('from_email'));
  test('demo mode: original_to', () => expect(R.matchReplyToLead({ from_email: 'prospect@t.test', original_to: 'b@firma2.de' }, leads, []).lead.id).toBe('L2'));
  test('thread linked via lead_record_id', () => expect(R.matchReplyToLead({ thread_id: 'T9' }, leads, emails).lead.id).toBe('L1'));
  test('no match', () => expect(R.matchReplyToLead({ from_email: 'z@z.de' })).toEqual({ lead: null, by: null }));
});

describe('routeReply', () => {
  test('interested above threshold auto-sends', () => expect(R.routeReply({ category: 'Interested', confidence: 0.9 }, cfg)).toMatchObject({ branch: 'Interested', autoSend: true, askSlack: false }));
  test('interested at exactly 0.85 auto-sends', () => expect(R.routeReply({ category: 'Interested', confidence: 0.85 }, cfg).autoSend).toBe(true));
  test('interested below threshold asks Slack', () => expect(R.routeReply({ category: 'Interested', confidence: 0.8 }, cfg)).toMatchObject({ autoSend: false, askSlack: true }));
  test('below 0.7 is unsure whatever the category', () => expect(R.routeReply({ category: 'Not interested', confidence: 0.69 }, cfg).branch).toBe('Unsure'));
  test('Unclear is unsure', () => expect(R.routeReply({ category: 'Unclear', confidence: 0.9 }, cfg).branch).toBe('Unsure'));
  test('later uses return date or +30 days', () => {
    expect(R.routeReply({ category: 'Later', confidence: 0.9, return_date: '2027-01-12' }, cfg, NOW).followUpAt).toBe('2027-01-12T08:00:00.000Z');
    expect(R.routeReply({ category: 'Later', confidence: 0.9 }, cfg, NOW).followUpAt).toBe('2026-12-14T10:00:00.000Z');
  });
  test('not interested closes, unsubscribe blocks', () => {
    expect(R.routeReply({ category: 'Not interested', confidence: 0.9 }, cfg).leadStatus).toBe('Not interested');
    expect(R.routeReply({ category: 'Unsubscribe', confidence: 1 }, cfg)).toMatchObject({ leadStatus: 'Unsubscribed', block: true });
  });
  test('out of office resumes return_date + 1 day (demo: 5 minutes)', () => {
    expect(R.routeReply({ category: 'Out of office', confidence: 0.95, return_date: '2026-11-24' }, cfg, NOW).resumeAt).toBe('2026-11-25T08:00:00.000Z');
    expect(R.routeReply({ category: 'Out of office', confidence: 0.95 }, cfg, NOW).resumeAt).toBe('2026-11-22T10:00:00.000Z');
    expect(R.routeReply({ category: 'Out of office', confidence: 0.95 }, Object.assign({ demoMode: true }, cfg), NOW).resumeAt).toBe('2026-11-14T10:05:00.000Z');
  });
  test('unknown category and defaults', () => {
    expect(R.routeReply({ category: 'Weird', confidence: 0.99 }, cfg).branch).toBe('Unsure');
    expect(R.routeReply({ category: 'Interested', confidence: 0.86 }).autoSend).toBe(true);
  });
});
