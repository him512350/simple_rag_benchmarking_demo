import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenRouter, ApiError } from '../lib/openrouter.js';
import { createHandlers } from '../lib/handlers.js';
import { resultMetadata } from '../lib/result-metadata.js';
import { cleanRows, DEFAULT_PROJECT } from '../lib/projects.js';
import { parseCSV, resultsCSV } from '../src/csv.js';

const model = (extra = {}) => ({ id: 'test/model', name: 'Test', context_length: 128000, architecture: { input_modalities: ['text'], output_modalities: ['text'] }, supported_parameters: ['max_completion_tokens'], top_provider: { max_completion_tokens: 4096 }, ...extra });
const body = () => ({ model: 'test/model', systemPrompt: 'System', question: 'Question', documents: [] });
const response = () => ({ setHeader() {}, status(code) { this.code = code; return this; }, json(value) { this.body = value; return this; } });
const usage = { prompt_tokens: 592, completion_tokens: 4096, total_tokens: 4688 };
async function run(payload, options = {}) {
  let sent;
  const service = createOpenRouter(async (url, request) => url.endsWith('/models') ? { ok: true, json: async () => ({ data: [model(options.model)] }) } : (sent = JSON.parse(request.body), { ok: options.status == null, status: options.status, json: async () => payload }));
  const res = response(); await createHandlers(service, () => 'server-key-test-only').benchmark({ method: 'POST', headers: { 'content-type': 'application/json' }, body: body() }, res);
  return { res, sent };
}

test('normal and partial-length completions keep text, safe metrics, finish reason and actual 4096 cap', async () => {
  for (const finish of ['stop', 'length']) {
    const { res, sent } = await run({ choices: [{ message: { content: 'Partial or full answer', reasoning: 'hidden_reasoning_sentinel' }, finish_reason: finish }], usage });
    assert.equal(res.code, 200); assert.equal(res.body.response, 'Partial or full answer'); assert.equal(res.body.finishReason, finish); assert.equal(res.body.truncated, finish === 'length'); assert.equal(res.body.outputTokens, 4096); assert.deepEqual(res.body.usage, usage); assert.ok(res.body.elapsedMs >= 0); assert.equal(sent.max_completion_tokens, 4096); assert.equal(sent.reasoning, undefined); assert.ok(!JSON.stringify(res.body).includes('hidden_reasoning_sentinel'));
  }
  const legacyParameter = await run({ choices: [{ message: { content: 'Answer' }, finish_reason: 'stop' }] }, { model: { supported_parameters: ['max_tokens'] } }); assert.equal(legacyParameter.sent.max_tokens, 4096); assert.equal(legacyParameter.sent.max_completion_tokens, undefined);
});

test('empty-length returns a budget-specific error with usage/time but no hidden provider fields', async () => {
  const { res } = await run({ choices: [{ message: { content: '', reasoning: 'hidden_reasoning_sentinel', reasoning_details: [{ secret: 'private' }] }, finish_reason: 'length' }], usage: { ...usage, reasoning_tokens: 4096 }, provider: 'private-provider' });
  assert.equal(res.code, 502); assert.match(res.body.error, /output limit before returning an answer/); assert.equal(res.body.result.outputTokens, 4096); assert.equal(res.body.result.truncated, true); assert.equal(res.body.result.finishReason, 'length'); assert.deepEqual(res.body.result.usage, usage); assert.ok(res.body.result.elapsedMs >= 0); assert.ok(!/hidden_reasoning_sentinel|reasoning_tokens|private-provider|reasoning_details/.test(JSON.stringify(res.body)));
});

test('provider errors remain sanitized and available metrics are bounded', async () => {
  let output = await run({ error: 'provider_secret_sentinel', choices: [{ message: { content: null }, finish_reason: 'error' }], usage: { prompt_tokens: -1, completion_tokens: 2, total_tokens: NaN } });
  assert.equal(output.res.code, 502); assert.equal(output.res.body.result.finishReason, 'error'); assert.deepEqual(output.res.body.result.usage, { prompt_tokens: null, completion_tokens: 2, total_tokens: null }); assert.ok(!JSON.stringify(output.res.body).includes('provider_secret_sentinel'));
  output = await run({ error: 'provider_secret_sentinel' }, { status: 429 }); assert.equal(output.res.code, 429); assert.equal(output.res.body.result.usage, null); assert.equal(output.res.body.result.outputTokens, 4096); assert.ok(!JSON.stringify(output.res.body).includes('provider_secret_sentinel'));
  assert.deepEqual(resultMetadata({ elapsedMs: -1, usage: { prompt_tokens: Infinity, total_tokens: '3' }, finishReason: 'untrusted_finish', outputTokens: 2000, secret: 'not safe' }), { elapsedMs: null, usage: { prompt_tokens: null, completion_tokens: null, total_tokens: null }, truncated: false, finishReason: null, outputTokens: null });
  const error = new ApiError(502, 'Safe error'); error.result = { elapsedMs: 3, secret: 'not safe' }; const res = response(); await createHandlers({ completion: async () => { throw error; } }, () => 'key').benchmark({ method: 'POST', headers: { 'content-type': 'application/json' }, body: body() }, res); assert.ok(!JSON.stringify(res.body).includes('not safe'));
});

test('model eligibility and context reserve enforce a genuine 4096-token output budget', async () => {
  const calls = [];
  const service = createOpenRouter(async (url, request) => { if (url.endsWith('/models')) return { ok: true, json: async () => ({ data: [model({ id: 'too-small', top_provider: { max_completion_tokens: 4095 } }), model({ id: 'zero', top_provider: { max_completion_tokens: 0 } }), model({ id: 'tiny-context', context_length: 4096 }), model({ context_length: 4600 })] }) }; calls.push(request); return { ok: true, json: async () => ({ choices: [{ message: { content: 'Answer' }, finish_reason: 'stop' }] }) }; });
  assert.deepEqual((await service.models()).map(item => item.id), ['test/model']);
  await assert.rejects(() => service.completion({ ...body(), question: 'a'.repeat(300) }, 'key'), /context window/); assert.equal(calls.length, 0);
  await service.completion({ ...body(), question: 'a'.repeat(10) }, 'key'); assert.equal(JSON.parse(calls[0].body).max_completion_tokens, 4096);
});

test('saved historical output limits stay 1024, new rows stay 4096, including error metrics and CSV', () => {
  const provenance = { projectId: 'default', projectName: 'Default', model: 'test/model', systemPrompt: 'System', documentNames: [], documentFingerprints: [], runAt: '2026-11-04T01:00:00.000Z' };
  const old = { id: '01', input: 'Question', status: 'done', response: 'Old answer', error: '', elapsedMs: 8620, usage: { prompt_tokens: 592, completion_tokens: 1024, total_tokens: 1616 }, truncated: true, provenance };
  const empty = { ...old, id: '02', status: 'error', response: '', error: 'Output budget exhausted', usage, finishReason: 'length', provenance: { ...provenance, outputTokens: 4096 } };
  const rows = cleanRows([old, empty], DEFAULT_PROJECT); assert.equal(rows[0].provenance.outputTokens, 1024); assert.equal(rows[0].finishReason, 'length'); assert.equal(rows[1].provenance.outputTokens, 4096); assert.deepEqual(rows[1].usage, usage);
  const csv = parseCSV(resultsCSV(rows, null, DEFAULT_PROJECT)); const cap = csv[0].indexOf('output_limit'); assert.equal(csv[1][cap], '1024'); assert.equal(csv[2][cap], '4096');
  assert.throws(() => cleanRows([{ ...old, provenance: { ...provenance, outputTokens: 2048 } }], DEFAULT_PROJECT), /output limit/);
});
