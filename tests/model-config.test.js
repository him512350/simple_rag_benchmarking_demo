import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenRouter } from '../lib/openrouter.js';
import { ALLOWED_MODEL_IDS, DEFAULT_MODEL_ID, defaultModelId, isModelAllowed } from '../lib/model-config.js';

const metadata = id => ({ id, name: id, context_length: 128000, top_provider: { max_completion_tokens: 4096 }, architecture: { input_modalities: ['text'], output_modalities: ['text'] }, supported_parameters: ['max_tokens'] });
const body = model => ({ model, systemPrompt: 'System', question: 'Question', documents: [] });
function transport(models) { const requests = []; return { requests, fetch: async (url, options) => url.endsWith('/models') ? { ok: true, json: async () => ({ data: models }) } : (requests.push(JSON.parse(options.body)), { ok: true, json: async () => ({ choices: [{ message: { content: 'Answer' }, finish_reason: 'stop' }] }) }) }; }

test('default configuration pins both advertised models and completion authorization to Nemotron free', async () => {
  const network = transport([metadata('other/paid'), metadata(DEFAULT_MODEL_ID)]); const service = createOpenRouter(network.fetch, [DEFAULT_MODEL_ID]);
  assert.deepEqual((await service.models()).map(model => model.id), [DEFAULT_MODEL_ID]);
  const configured = createOpenRouter(network.fetch);
  assert.deepEqual((await configured.models()).map(model => model.id), ['other/paid', DEFAULT_MODEL_ID].filter(id => isModelAllowed(id, ALLOWED_MODEL_IDS)));
  await assert.rejects(() => service.completion(body('other/paid'), 'test-key'), /supported text model/); assert.equal(network.requests.length, 0);
  await service.completion(body(DEFAULT_MODEL_ID), 'test-key'); assert.equal(network.requests[0].model, DEFAULT_MODEL_ID); assert.equal(network.requests[0].max_tokens, 4096);
});
test('null restriction restores all compatible models and prefers the target when available', async () => {
  const network = transport([metadata('other/paid'), metadata(DEFAULT_MODEL_ID), { ...metadata('image/model'), architecture: { input_modalities: ['text'], output_modalities: ['text', 'image'] } }]);
  const service = createOpenRouter(network.fetch, null); const models = await service.models(); assert.equal(models.length, 2); assert.equal(defaultModelId(models, null), DEFAULT_MODEL_ID);
  await service.completion(body('other/paid'), 'test-key'); assert.equal(network.requests[0].model, 'other/paid'); assert.equal(defaultModelId([{ id: 'other/paid' }], null), 'other/paid');
});
test('missing or incompatible pinned model never silently falls back to another model', async () => {
  const network = transport([metadata('other/paid'), { ...metadata(DEFAULT_MODEL_ID), top_provider: { max_completion_tokens: 1024 } }]); const service = createOpenRouter(network.fetch, [DEFAULT_MODEL_ID]);
  assert.deepEqual(await service.models(), []); assert.throws(() => defaultModelId([{ id: 'other/paid' }], [DEFAULT_MODEL_ID]), /unavailable.*No other model will be selected/);
  await assert.rejects(() => service.completion(body(DEFAULT_MODEL_ID), 'test-key'), /supported text model/); assert.equal(network.requests.length, 0);
});
