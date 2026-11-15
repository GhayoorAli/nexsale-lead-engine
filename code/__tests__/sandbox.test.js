/**
 * Every module must run inside the n8n Code node sandbox, which has no URL, URLSearchParams,
 * TextEncoder, structuredClone or global crypto (probed on n8n 1.123.5). This test loads each
 * module the same way scripts/n8n_builder.js embeds it, in a VM context with only the
 * globals n8n provides, and runs a smoke call.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DIR = path.join(__dirname, '..');
const modules = fs.readdirSync(DIR).filter((f) => f.endsWith('.js')).map((f) => f.replace(/\.js$/, ''));

function load(name) {
  const src = fs.readFileSync(path.join(DIR, name + '.js'), 'utf8');
  const wrapped = `(function () { const module = { exports: {} }; ${src}\n return module.exports; })()`;
  const ctx = vm.createContext({ Buffer, Intl, setTimeout, console, Date, Math, JSON });
  return vm.runInContext(wrapped, ctx);
}

test.each(modules)('%s loads without Node-only globals', (name) => {
  const api = load(name);
  expect(Object.keys(api).length).toBeGreaterThan(0);
});

test('smoke calls inside the sandbox', () => {
  expect(load('mapPlaces').extractDomain('https://www.firma.de/x?y=1')).toBe('firma.de');
  expect(load('mapPlaces').mapPlaces(require('../../tests/fixtures/google_places_berlin_10.json'), {}).leads).toHaveLength(10);
  expect(load('parseImpressum').findImpressumLink('<a href="https://x.de/impressum">I</a>')).toBe('/impressum');
  expect(load('slackSignature').parseSlackPayload('payload=%7B%22a%22%3A1%7D')).toEqual({ a: 1 });
  expect(load('schedule').isSendWindow('2026-11-16T09:00:00Z')).toBe(true);
  expect(load('mime').decodeRawEmail(load('mime').buildRawEmail({ to: 'a@b.de', subject: 'Grüße', body: 'x' })).subject).toBe('Grüße');
  expect(load('config').buildConfig({}).demoMode).toBe(true);
  expect(() => load('guard').guardEmail({ to: 'info@real-firma.de' }, { demoMode: true, testProspectEmail: 'info@real-firma.de', allowlist: ['p@t.test'] })).toThrow(/allowlist/);
});
