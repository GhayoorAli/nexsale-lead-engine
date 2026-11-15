const A = require('../aiRequest');

test('fillTemplate', () => {
  expect(A.fillTemplate('Hallo <<name>>, <<obj>> <<missing>>.', { name: 'Anna', obj: { a: 1 } })).toBe('Hallo Anna, {"a":1} .');
  expect(A.fillTemplate('<< name >>', { name: 0 })).toBe('0');
  expect(A.fillTemplate('x')).toBe('x');
});
test('splitPrompt', () => {
  expect(A.splitPrompt('## System\nSys text\n\n## User\nUser <<x>>')).toEqual({ system: 'Sys text', user: 'User <<x>>' });
  expect(A.splitPrompt('only system')).toEqual({ system: 'only system', user: '' });
  expect(A.splitPrompt(null)).toEqual({ system: '', user: '' });
});
test('buildAiRequest openai uses json mode', () => {
  const r = A.buildAiRequest({ provider: 'openai', model: 'gpt-4o-mini', system: 's', user: 'u' });
  expect(r.response_format).toEqual({ type: 'json_object' });
  expect(r.messages).toEqual([{ role: 'system', content: 's' }, { role: 'user', content: 'u' }]);
  expect(r.max_tokens).toBe(1500);
  expect(r.temperature).toBe(0.4);
});
test('buildAiRequest anthropic', () => {
  const r = A.buildAiRequest({ provider: 'anthropic', model: 'claude-haiku-5-5', system: 's', user: 'u', maxTokens: 10, temperature: 0 });
  expect(r.system).toMatch(/^s\n/);
  expect(r.messages).toEqual([{ role: 'user', content: 'u' }]);
  expect(r.max_tokens).toBe(10);
  expect(r.temperature).toBe(0);
});
test('estimateCostEur', () => {
  expect(A.estimateCostEur('gpt-4o-mini', { input: 1e6, output: 1e6 })).toBeCloseTo(0.69, 5);
  expect(A.estimateCostEur('other', { input: 1000 })).toBeCloseTo(0.00092, 6);
  expect(A.estimateCostEur('gpt-4o-mini')).toBe(0);
});
