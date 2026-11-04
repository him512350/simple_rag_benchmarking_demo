import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenRouter } from '../lib/openrouter.js';
const body = { model: 'qwen/qwen3.8-flash', systemPrompt: 'Test', question: 'Hello', documents: [], url: 'https://evil.test' };
const model = { id: body.model, context_length: 1000000, architecture: { input_modalities: ['text'], output_modalities: ['text'] }, supported_parameters: ['max_tokens'], top_provider: { max_completion_tokens: 131072 } };
const metadata = { ok: true, json: async () => ({ data: [model] }) };
test('gateway keeps public metadata separate and sends key only to configured completion endpoint', async () => {
  const calls = [];
  const service = createOpenRouter(async (url, options = {}) => { calls.push({ url, options }); return url.endsWith('/models') ? metadata : { ok: true, json: async () => ({ choices: [{ message: { content: 'Answer' } }] }) }; }, undefined, () => ' https://gateway.test/v1/// ');
  await service.completion(body, 'gateway-test-key');
  assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/models'); assert.equal(calls[0].options.headers, undefined);
  assert.equal(calls[1].url, 'https://gateway.test/v1/chat/completions'); assert.equal(calls[1].options.headers.Authorization, 'Bearer gateway-test-key'); assert.equal(calls[1].options.redirect, 'error');
  const payload = JSON.parse(calls[1].options.body); assert.equal(payload.max_tokens, 4096); assert.equal(payload.url, undefined);
});
test('official default remains compatible and unsafe base URLs fail before fetch', async () => {
  let last;
  const service = createOpenRouter(async url => { last = url; return url.endsWith('/models') ? metadata : { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) }; }, undefined, () => undefined);
  await service.completion(body, 'key'); assert.equal(last, 'https://openrouter.ai/api/v1/chat/completions');
  for (const base of ['http://gateway.test/v1', 'https://user:pass@gateway.test/v1', 'https://gateway.test/v1?x=1', 'https://gateway.test/v1#x', 'invalid']) {
    await assert.rejects(() => createOpenRouter(() => { throw Error('must not fetch'); }, undefined, () => base).completion(body, 'key'), error => error.status === 503);
  }
});
test('gateway failures use safe endpoint messages and preserve no upstream error content', async () => {
  for (const [status, expected] of [[401, /endpoint rejected the server API key/], [429, /weekly allowance.*in progress/], [502, /upstream completion service is unavailable/]]) {
    const service = createOpenRouter(async url => url.endsWith('/models') ? metadata : { ok: false, status, json: async () => ({ error: 'secret-provider-body' }) }, undefined, () => 'https://gateway.test/v1');
    await assert.rejects(() => service.completion(body, 'key'), error => expected.test(error.message) && !error.message.includes('secret-provider-body') && error.result.usage === null);
  }
});
