import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenRouter } from '../lib/openrouter.js';
import { LIMITS, utf8Bytes } from '../lib/limits.js';
const policy = 'Answer only using the reference documents provided with this request only.\nDo not use your own knowledge or make assumptions.';
const body = { model: 'test/model', systemPrompt: '使用者原文 https://example.test', question: 'Question', documents: [] };
function service(contextLength, calls) {
  return createOpenRouter(async (url, options) => {
    if (url.endsWith('/models')) return { ok: true, json: async () => ({ data: [{ id: body.model, context_length: contextLength, architecture: { input_modalities: ['text'], output_modalities: ['text'] }, supported_parameters: ['max_tokens'] }] }) };
    calls.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ choices: [{ message: { content: 'Answer' } }] }) };
  }, null, () => undefined);
}
test('reference policy prefixes one system message without mutating editable prompt or requiring documents', async () => {
  const calls = [], original = structuredClone(body);
  await service(128000, calls).completion(body, 'test-key');
  assert.deepEqual(body, original);
  assert.deepEqual(calls[0].messages, [{ role: 'system', content: `${policy}\n\n${body.systemPrompt}` }, { role: 'user', content: body.question }]);
});
test('context reserve counts actual prefixed system UTF-8 bytes at the boundary', async () => {
  const exact = utf8Bytes(`${policy}\n\n${body.systemPrompt}`) + utf8Bytes(body.question) + LIMITS.outputTokens + 256;
  const calls = []; await service(exact, calls).completion(body, 'test-key'); assert.equal(calls.length, 1);
  const rejected = []; await assert.rejects(() => service(exact - 1, rejected).completion(body, 'test-key'), /context window/); assert.equal(rejected.length, 0);
});

test('200000-character Unicode prompt passes byte validation and runs only when actual model context fits', async () => {
  const { validateBody } = await import('../lib/handlers.js');
  const request = { ...body, systemPrompt: '中'.repeat(200000) };
  assert.deepEqual(validateBody(request), request);
  assert.throws(() => validateBody({ ...request, systemPrompt: request.systemPrompt + '中' }), /200,000/);
  const calls = []; await service(1000000, calls).completion(request, 'test-key'); assert.equal(calls[0].messages[0].content, `${policy}\n\n${request.systemPrompt}`);
  await assert.rejects(() => service(128000, []).completion(request, 'test-key'), /context window/);
  const escaped = { ...request, systemPrompt: '\u0001'.repeat(200000), documents: [{ name: 'reference.pdf', text: '\u0001'.repeat(60000) }], question: '\u0001'.repeat(4000) };
  assert.deepEqual(validateBody(escaped), escaped);
});
