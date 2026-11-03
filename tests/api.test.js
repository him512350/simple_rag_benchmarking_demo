import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHandlers, validateBody } from '../lib/handlers.js';
import { createOpenRouter } from '../lib/openrouter.js';
import { LIMITS } from '../lib/limits.js';

const good = () => ({ model: 'test/model', systemPrompt: 'Classify the question.', question: '你好?', documents: [{ name: 'policy.pdf', text: 'Full document text.' }] });
function response() {
  const res = new EventEmitter(); res.headers = {}; res.setHeader = (key, value) => { res.headers[key] = value; }; res.status = code => { res.code = code; return res; }; res.json = body => { res.body = body; res.writableEnded = true; return res; }; return res;
}
const request = (body = good(), method = 'POST') => Object.assign(new EventEmitter(), { method, body, headers: { 'content-type': 'application/json' } });
const metadata = (overrides = {}) => ({ id: 'test/model', name: 'Test model', context_length: 128000, architecture: { input_modalities: ['text'], output_modalities: ['text'] }, supported_parameters: ['max_completion_tokens'], top_provider: { max_completion_tokens: 4096 }, ...overrides });

test('server rejects missing key without exposing config values', async () => {
  const handlers = createHandlers({}, () => ''); const res = response(); await handlers.benchmark(request(), res); assert.equal(res.code, 503); assert.match(res.body.error, /not configured/);
  const list = response(); await handlers.models(request(null, 'GET'), list); assert.equal(list.code, 503);
});
test('validation enforces types, byte/text/document limits', () => {
  for (const body of [null, [], { ...good(), systemPrompt: ' ' }, { ...good(), question: 'a'.repeat(4001) }, { ...good(), documents: Array.from({ length: 11 }, () => ({ name: 'x', text: 'y' })) }, { ...good(), documents: [{ name: 'x', text: 'a'.repeat(60001) }] }, { ...good(), systemPrompt: 'a'.repeat(12001) }]) assert.throws(() => validateBody(body));
  assert.throws(() => validateBody({ ...good(), extra: 'x'.repeat(LIMITS.requestBytes) }), /too large/);
  assert.deepEqual(validateBody({ ...good(), messages: ['ignore'], url: 'http://evil.test' }), good());
});
test('fixed upstream, secret server-side, model filtering/cache, output cap, full context and usage', async () => {
  const calls = []; const secret = 'server-secret-test-only';
  const service = createOpenRouter(async (url, options = {}) => { calls.push({ url, options }); return url.endsWith('/models') ? { ok: true, json: async () => ({ data: [metadata(), metadata({ id: 'openrouter/auto' }), metadata({ id: 'test/image', architecture: { input_modalities: ['text'], output_modalities: ['text', 'image'] } }), metadata({ id: 'test/uncapped', supported_parameters: [] })] }) } : { ok: true, json: async () => ({ choices: [{ message: { content: 'Answer' }, finish_reason: 'length' }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } }) }; });
  const handlers = createHandlers(service, () => secret); const list = response(); await handlers.models(request(null, 'GET'), list); assert.equal(list.body.models.length, 1);
  const res = response(); await handlers.benchmark(request(), res); assert.equal(res.code, 200); assert.equal(res.body.response, 'Answer'); assert.equal(res.body.truncated, true); assert.equal(res.body.usage.total_tokens, 25); assert.ok(!JSON.stringify(res.body).includes(secret)); assert.ok(!JSON.stringify(list.body).includes(secret)); assert.equal(calls.length, 2);
  assert.equal(calls[1].url, 'https://openrouter.ai/api/v1/chat/completions'); assert.equal(calls[1].options.headers.Authorization, 'Bearer ' + secret);
  const payload = JSON.parse(calls[1].options.body); assert.equal(payload.max_completion_tokens, 1024); assert.deepEqual(payload.messages[0], { role: 'system', content: good().systemPrompt }); assert.match(payload.messages[1].content, /Full document text/); assert.match(payload.messages[1].content, /你好/); assert.equal(payload.messages.length, 2);
});
test('invalid model/context rejected, metadata output parameter honored, provider errors sanitized', async () => {
  let fail = false; let seen;
  const service = createOpenRouter(async (url, options) => url.endsWith('/models') ? { ok: true, json: async () => ({ data: [metadata({ context_length: 2048, supported_parameters: ['max_tokens'] })] }) } : (seen = JSON.parse(options.body), fail ? { ok: false, status: 401, json: async () => ({ error: 'secret_should_never_leak' }) } : { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) }));
  await assert.rejects(() => service.completion({ ...good(), model: 'invalid' }, 'key'), /valid text model/);
  await assert.rejects(() => service.completion({ ...good(), question: '中'.repeat(1000) }, 'key'), /context window/);
  const result = await service.completion(good(), 'key'); assert.equal(result.usage.total_tokens, null); assert.equal(seen.max_tokens, 1024); assert.equal(seen.max_completion_tokens, undefined);
  fail = true; const res = response(); await createHandlers(service, () => 'key').benchmark(request(), res); assert.equal(res.code, 502); assert.ok(!JSON.stringify(res.body).includes('secret_should_never_leak'));
});
test('HTTP methods, content type and raw payload size are rejected', async () => {
  const handlers = createHandlers({}, () => 'key');
  for (const [req, status] of [[request(null, 'GET'), 405], [Object.assign(request(), { headers: {} }), 415], [Object.assign(request(), { headers: { 'content-length': LIMITS.requestBytes + 1 } }), 413], [request('{invalid'), 400]]) { const res = response(); await handlers.benchmark(req, res); assert.equal(res.code, status); }
});
test('disconnect aborts the upstream signal', async () => {
  let receivedSignal; const res = response();
  const service = { completion: async (body, key, signal) => { receivedSignal = signal; res.emit('close'); throw new DOMException('Aborted', 'AbortError'); } };
  await createHandlers(service, () => 'key').benchmark(request(), res); assert.equal(receivedSignal.aborted, true);
});

test('production API entrypoints import as ESM and use the shared handlers', async () => {
  const models = await import('../api/models.js'); const benchmark = await import('../api/benchmark.js');
  assert.equal(typeof models.default, 'function'); assert.equal(typeof benchmark.default, 'function');
  const res = response(); await benchmark.default(request(null, 'GET'), res); assert.equal(res.code, 405);
  const config = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
  assert.equal(config.framework, 'vite'); assert.equal(config.functions['api/benchmark.js'].maxDuration, 60);
});
