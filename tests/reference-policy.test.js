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
