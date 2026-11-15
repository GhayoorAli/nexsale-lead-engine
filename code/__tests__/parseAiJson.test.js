const P = require('../parseAiJson');

describe('parseAiJson', () => {
  test('valid JSON', () => expect(P.parseAiJson('{"a":1}')).toEqual({ ok: true, data: { a: 1 } }));
  test('JSON in code fences', () => expect(P.parseAiJson('```json\n{"a":[1,2]}\n```').data).toEqual({ a: [1, 2] }));
  test('JSON wrapped in text', () => expect(P.parseAiJson('Hier ist das Ergebnis: {"category":"Later","note":"a } b"} Danke.').data).toEqual({ category: 'Later', note: 'a } b' }));
  test('array wrapped in text', () => expect(P.parseAiJson('Ergebnis: [{"step":1}] fertig').data).toEqual([{ step: 1 }]));
  test('object containing an array is preferred when it comes first', () => expect(P.parseAiJson('x {"emails":[1]} y').data).toEqual({ emails: [1] }));
  test('escaped quotes inside strings', () => expect(P.parseAiJson('{"t":"er sagte \\"hi\\" {"}').data).toEqual({ t: 'er sagte "hi" {' }));
  test.each(['{"a":', 'not json at all', '{bad: json}', '   ', '[1,2'])('broken JSON returns an error and never crashes: %p', (t) => {
    const r = P.parseAiJson(t);
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });
  test('null / undefined / object', () => {
    expect(P.parseAiJson(null).ok).toBe(false);
    expect(P.parseAiJson(undefined).ok).toBe(false);
    expect(P.parseAiJson({ a: 1 })).toEqual({ ok: true, data: { a: 1 } });
  });
});

describe('extractAiText', () => {
  test('openai', () => expect(P.extractAiText({ choices: [{ message: { content: '{"a":1}' } }] }, 'openai')).toBe('{"a":1}'));
  test('anthropic', () => expect(P.extractAiText({ content: [{ type: 'text', text: '{"a"' }, { type: 'text', text: ':1}' }] }, 'anthropic')).toBe('{"a":1}'));
  test('anthropic shape detected without provider', () => expect(P.extractAiText({ content: [{ type: 'text', text: 'x' }, null] })).toBe('x'));
  test('empty', () => {
    expect(P.extractAiText(null)).toBe('');
    expect(P.extractAiText({ choices: [] })).toBe('');
    expect(P.extractAiText({ content: null }, 'anthropic')).toBe('');
  });
  test('usage', () => {
    expect(P.extractUsage({ usage: { prompt_tokens: 10, completion_tokens: 5 } })).toEqual({ input: 10, output: 5 });
    expect(P.extractUsage({ usage: { input_tokens: 3, output_tokens: 4 } })).toEqual({ input: 3, output: 4 });
    expect(P.extractUsage(null)).toEqual({ input: 0, output: 0 });
  });
});
