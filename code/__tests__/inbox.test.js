const path = require('path');
const fs = require('fs');
const { toReplyPayloads } = require('../inbox');

const mail = (id, from, subject) => ({ json: { id, threadId: 't-' + id, from: { text: from }, to: { text: 'sender@x.de' }, subject, text: 'Text ' + id, date: '2026-11-15T20:19:43Z', headers: { 'message-id': '<' + id + '>' }, extra: 'dropped' } });
// live case: Calendly notification + two lead replies in the same minute
const poll = [mail('m1', 'Petra Klein <klein@hv.de>', 'Re: Unterhaltsreinigung'), mail('m2', 'Calendly <notifications@calendly.com>', 'New Event'), mail('m3', 'Tom <tom@firma.de>', 'AW: Termin')];

test('every mail of a poll becomes one payload with the fields 07_replies reads', () => {
  const p = toReplyPayloads(poll);
  expect(p.map((x) => x.id)).toEqual(['m1', 'm2', 'm3']);
  expect(p[0]).toEqual({ id: 'm1', threadId: 't-m1', from: { text: 'Petra Klein <klein@hv.de>' }, to: { text: 'sender@x.de' }, subject: 'Re: Unterhaltsreinigung', text: 'Text m1', date: '2026-11-15T20:19:43Z', headers: { 'message-id': '<m1>' } });
});
test('duplicates and empty items are skipped; plain objects work too', () => {
  expect(toReplyPayloads([poll[0], poll[0], null, { json: {} }, poll[1].json]).map((x) => x.id)).toEqual(['m1', 'm2']);
  expect(toReplyPayloads()).toEqual([]);
});

test('the generated 07a workflow hands over all 3 mails of one poll (live bug: crashed at 2)', () => {
  const wf = JSON.parse(fs.readFileSync(path.join(__dirname, '../../workflows/07a_gmail_inbox.json'), 'utf8'));
  const node = (n) => wf.nodes.find((x) => x.name === n);
  const code = node('Mails to hand over').parameters.jsCode;
  const $ = (name) => ({ all: () => (name === 'New mail in sender inbox' ? poll : []), first: () => ({ json: {} }) });
  const out = new Function('$', '$env', code)($, {}); // eslint-disable-line no-new-func
  expect(out.map((i) => i.json.id)).toEqual(['m1', 'm2', 'm3']);
  // the hand-over posts each item as it is – no paired-item lookup back across Config
  const http = JSON.stringify(node('Hand to 07_replies').parameters);
  expect(http).toMatch(/JSON\.stringify\(\$json\)/);
  expect(http).not.toMatch(/\.item\./);
  const order = wf.connections.Config.main[0].map((c) => c.node);
  expect(order).toEqual(['Mails to hand over']);
});
