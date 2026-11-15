const G = require('../guard');

const cfg = {
  demoMode: true,
  testProspectEmail: 'prospect.test@nexsale-demo.test',
  allowlist: ['prospect.test@nexsale-demo.test', 'sender.test@nexsale-demo.test'],
};

describe('guardEmail – safety rules', () => {
  test('SAFETY: an email to a real company address is rewritten in DEMO_MODE, never sent to the company', () => {
    const out = G.guardEmail({ to: 't.becker@glanzwerk-berlin.example', subject: 'Hallo', body: 'x' }, cfg);
    expect(out.to).toBe('prospect.test@nexsale-demo.test');
    expect(out.original_to).toBe('t.becker@glanzwerk-berlin.example');
    expect(out.subject).toBe('[TEST] Hallo');
    expect(out.guard.recipients).toEqual(['prospect.test@nexsale-demo.test']);
  });

  test('SAFETY: a real company address is BLOCKED when it would really be sent (allowlist enforced)', () => {
    const misconfigured = Object.assign({}, cfg, { testProspectEmail: 'info@real-firma.de' });
    expect(() => G.guardEmail({ to: 'info@real-firma.de', subject: 's' }, misconfigured)).toThrow(/not on allowlist: info@real-firma.de/);
  });

  test('SAFETY: real company in cc/bcc is blocked even outside demo mode', () => {
    const real = { demoMode: false, allowRealSending: true, allowlist: ['prospect.test@nexsale-demo.test'] };
    expect(() => G.guardEmail({ to: 'prospect.test@nexsale-demo.test', cc: 'kontakt@firma-gmbh.de' }, real)).toThrow(GuardErrorMatcher());
  });

  test('empty allowlist blocks everything', () => {
    expect(() => G.guardEmail({ to: 'prospect.test@nexsale-demo.test' }, Object.assign({}, cfg, { allowlist: [] }))).toThrow(/allowlist is empty/i);
  });

  test('DEMO_MODE without TEST_PROSPECT_EMAIL blocks', () => {
    expect(() => G.guardEmail({ to: 'a@b.de' }, Object.assign({}, cfg, { testProspectEmail: '' }))).toThrow(/TEST_PROSPECT_EMAIL/);
  });

  test('real mode without ALLOW_REAL_SENDING blocks', () => {
    expect(() => G.guardEmail({ to: 'a@b.de' }, { demoMode: false, allowlist: [] })).toThrow(/ALLOW_REAL_SENDING/);
  });

  test('real mode with explicit opt-in and no allowlist passes', () => {
    const out = G.guardEmail({ to: 'Max <a@b.de>' }, { demoMode: false, allowRealSending: true, allowlist: [] });
    expect(out.to).toBe('Max <a@b.de>');
    expect(out.subject).toBeUndefined();
  });

  test('[TEST] prefix is not doubled; cc and bcc dropped', () => {
    const out = G.guardEmail({ to: 'x@y.de', cc: 'c@y.de', bcc: 'b@y.de', subject: '[TEST] Re: Hallo' }, cfg);
    expect(out.subject).toBe('[TEST] Re: Hallo');
    expect(out.cc).toBe('');
    expect(out.bcc).toBe('');
  });

  test('no recipient / no message / no config', () => {
    expect(() => G.guardEmail({ to: '' }, cfg)).toThrow(/no recipient/);
    expect(() => G.guardEmail(null, cfg)).toThrow(/no message/);
    expect(() => G.guardEmail({ to: 'a@b.de' }, null)).toThrow(/no config/);
  });

  test('allowlist is case-insensitive and supports display names', () => {
    const out = G.guardEmail({ to: 'Prospect <PROSPECT.TEST@nexsale-demo.test>' }, Object.assign({}, cfg, { demoMode: false, allowRealSending: true }));
    expect(out.guard.passed).toBe(true);
  });
});

function GuardErrorMatcher() {
  return /kontakt@firma-gmbh.de/;
}

describe('isBlocked', () => {
  const list = [{ value: 'stop@firma.de' }, { value: 'blocked.de' }, 'string-domain.de', { value: '' }, null];
  test.each([
    ['stop@firma.de', true],
    ['STOP@FIRMA.DE', true],
    ['other@firma.de', false],
    ['x@blocked.de', true],
    ['x@sub.blocked.de', true],
    ['x@string-domain.de', true],
    ['', false],
    [null, false],
  ])('%p -> %p', (email, res) => expect(G.isBlocked(email, list)).toBe(res));
  test('no list', () => expect(G.isBlocked('a@b.de')).toBe(false));
});

test('splitAddresses', () => {
  expect(G.splitAddresses(['A <a@b.de>', 'c@d.de'])).toEqual(['a@b.de', 'c@d.de']);
  expect(G.splitAddresses('a@b.de; c@d.de')).toEqual(['a@b.de', 'c@d.de']);
  expect(G.splitAddresses(null)).toEqual([]);
});
