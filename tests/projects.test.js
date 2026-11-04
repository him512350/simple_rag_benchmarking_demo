import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDefaults } from '../lib/defaults.js';
import { cleanRows, assertDefaultsSize, DEFAULT_PROJECT } from '../lib/projects.js';
import { LIMITS } from '../lib/limits.js';
import { validateBody } from '../lib/handlers.js';
import { resultsCSV, parseCSV } from '../src/csv.js';

const url = path => `https://test.public.blob.vercel-storage.com/${path}`;
const req = (body, project) => ({ method: body ? 'POST' : 'GET', url: `/api/defaults${project ? '?project=' + project : ''}`, headers: { 'content-type': 'application/json' }, body });
const response = () => ({ setHeader() {}, status(code) { this.code = code; return this; }, json(data) { this.data = data; return this; } });
function memory(options = {}) {
  const objects = new Map(); const puts = []; const fetched = []; const lists = [];
  const api = createDefaults({ getToken: () => 'test-token', getStoreId: () => '', security: { mutation() {}, requireAdmin() {} }, blob: {
    list: async ({ prefix, cursor }) => { lists.push(prefix); const matching = Array.from(objects, ([pathname, item]) => ({ pathname, url: url(pathname), uploadedAt: item.uploadedAt })).filter(item => item.pathname.startsWith(prefix)).reverse(); const start = Number(cursor || 0); return { blobs: matching.slice(start, start + 2), hasMore: start + 2 < matching.length, cursor: start + 2 < matching.length ? String(start + 2) : undefined }; },
    put: async (path, content) => { puts.push(path); objects.set(path, { content, uploadedAt: new Date(Date.now() + puts.length) }); },
  }, fetchImpl: async location => { fetched.push(location); return new Response(objects.get(new URL(location).pathname.slice(1)).content); }, ...options });
  async function call(body, project) { const res = response(); await api.handler(req(body, project), res); return res; }
  return { objects, puts, fetched, lists, api, call };
}
const sampleRow = (project, model = 'retired/model') => ({ id: '01', input: 'Question', status: 'done', response: 'Recorded answer', error: '', elapsedMs: 123, usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 }, truncated: false,
  provenance: { projectId: project.id, projectName: project.name, model, systemPrompt: 'Original run prompt', documentNames: ['policy.pdf'], documentFingerprints: [{ name: 'policy.pdf', sha256: 'a'.repeat(64), pathname: 'prompt-bench/pdfs/11111111-1111-4111-8111-111111111111.pdf' }], runAt: '2026-11-04T01:00:00.000Z' } });

test('create is one atomic immutable manifest with an empty case list; projects stay isolated', async () => {
  const state = memory(); const first = await state.call({ action: 'create', name: '服務 專案 / A' }); assert.equal(first.code, 201); assert.equal(state.puts.length, 1); assert.equal(first.data.defaults.documents.length, 0); assert.equal(first.data.defaults.systemPrompt, 'You are a customer service assistant powered by retrieval-augmented generation (RAG).'); assert.deepEqual(first.data.defaults.rows, []);
  const a = first.data.project; const second = await state.call({ action: 'create', name: 'Project B' }); const b = second.data.project;
  let saved = await state.call({ action: 'save', projectId: a.id, projectName: 'Cannot rename', systemPrompt: 'Prompt A', documents: [], rows: [sampleRow(a)] }); assert.equal(saved.code, 200); assert.equal(saved.data.project.name, a.name);
  saved = await state.call({ action: 'save', projectId: b.id, systemPrompt: 'Prompt B', documents: [], rows: [{ id: '01', input: 'B question', status: 'queued', response: 'forged' }] }); assert.equal(saved.code, 200);
  const readA = await state.call(null, a.id); assert.equal(readA.data.defaults.systemPrompt, 'Prompt A'); assert.equal(readA.data.defaults.rows[0].response, 'Recorded answer'); assert.equal(readA.data.defaults.rows[0].provenance.model, 'retired/model');
  const readB = await state.call(null, b.id); assert.equal(readB.data.defaults.systemPrompt, 'Prompt B'); assert.equal(readB.data.defaults.rows[0].response, ''); assert.equal(readB.data.projects.length, 3);
  assert.equal((await state.call(null)).data.defaults, null); // Other projects never become the default.
});

test('legacy default is read-only fallback; corrupt v2 never falls back, other IDs never fetch a foreign manifest', async () => {
  const state = memory(); const legacy = 'prompt-bench/defaults/1000-11111111-1111-4111-8111-111111111111.json'; state.objects.set(legacy, { uploadedAt: new Date(1000), content: JSON.stringify({ version: 1, systemPrompt: 'Legacy prompt', documents: [], savedAt: 'legacy' }) });
  let result = await state.call(null); assert.equal(result.code, 200); assert.equal(result.data.defaults.systemPrompt, 'Legacy prompt'); assert.equal(result.data.defaults.rows.length, 5); assert.equal(state.puts.length, 0);
  state.fetched.length = 0; result = await state.call(null, randomUUID()); assert.equal(result.code, 404); assert.equal(state.fetched.length, 0);
  result = await state.call(null, '../bad'); assert.equal(result.code, 400);
  await state.call({ action: 'save', projectId: 'default', systemPrompt: 'V2 prompt', documents: [], rows: [] });
  const latest = state.puts.at(-1); state.objects.get(latest).content = '{bad'; state.lists.length = 0;
  result = await state.call(null); assert.equal(result.code, 502); assert.ok(!state.lists.includes('prompt-bench/defaults/'));
});

test('row allowlist preserves separate run provenance and rejects impossible metrics/status/oversize data', () => {
  const p = DEFAULT_PROJECT; const original = sampleRow(p); const rows = cleanRows([{ ...original, extra: 'discard', provenance: { ...original.provenance, extra: 'discard' } }, { ...original, id: '02', provenance: { ...original.provenance, model: 'new/model' } }], p);
  assert.equal(rows[0].extra, undefined); assert.equal(rows[0].provenance.extra, undefined); assert.equal(rows[0].provenance.model, 'retired/model'); assert.equal(rows[1].provenance.model, 'new/model');
  for (const patch of [{ status: 'running' }, { elapsedMs: -1 }, { usage: { total_tokens: Infinity } }, { response: 'x'.repeat(LIMITS.responseChars + 1) }, { provenance: { ...original.provenance, projectId: randomUUID() } }, { provenance: { ...original.provenance, runAt: 'yesterday' } }]) assert.throws(() => cleanRows([{ ...original, ...patch }], p));
  assert.throws(() => assertDefaultsSize({ text: '中'.repeat(1100000) }), /3 MiB/);
  assert.throws(() => validateBody({ model: 'x', systemPrompt: 'x', question: 'x', documents: [], extra: 'x'.repeat(LIMITS.requestBytes + 1) }), /too large/);
});

test('export uses each saved row source, supports old snapshot fallback and leaves unrun provenance empty', () => {
  const a = sampleRow(DEFAULT_PROJECT); const b = { ...a, id: '02', provenance: { ...a.provenance, model: 'new/model', systemPrompt: 'New prompt' } }; const grid = parseCSV(resultsCSV([a, b, { id: '03', input: 'Unrun', status: 'queued' }], { model: 'wrong/global', documentNames: [], systemPrompt: 'Wrong' }, DEFAULT_PROJECT));
  const model = grid[0].indexOf('model'); assert.equal(grid[1][model], 'retired/model'); assert.equal(grid[2][model], 'new/model'); assert.equal(grid[3][model], ''); assert.ok(grid[1][grid[0].indexOf('document_fingerprints')].includes('a'.repeat(64)));
});

test('catalog enforces project/blob/page caps and ignores noncanonical project paths', async () => {
  const state = memory(); const name = Buffer.from('Bad project').toString('base64url'); state.objects.set(`prompt-bench/projects/not-a-uuid/${name}/1000-${randomUUID()}.json`, { uploadedAt: new Date(), content: '{}' }); assert.equal((await state.call(null)).data.projects.length, 1);
  for (let i = 0; i < 50; i++) state.objects.set(`prompt-bench/projects/${randomUUID()}/${name}/1000-${randomUUID()}.json`, { uploadedAt: new Date(), content: '{}' }); assert.equal((await state.call(null)).code, 503);
  const oversized = memory({ blob: { list: async () => ({ blobs: Array(10001).fill({ pathname: 'invalid' }), hasMore: false }) } }); assert.equal((await oversized.call(null)).code, 503);
  let calls = 0; const pages = memory({ blob: { list: async () => ({ blobs: [], hasMore: true, cursor: String(++calls) }) } }); assert.equal((await pages.call(null)).code, 503); assert.equal(calls, 100);
});

test('defaults 3 MiB cap is independent; invalid saves never create a version', async () => {
  const state = memory(); let result = await state.call({ action: 'save', projectId: 'default', systemPrompt: 'Prompt', documents: [] }); assert.equal(result.code, 400); assert.equal(state.puts.length, 0);
  result = await state.call({ action: 'save', projectId: 'default', systemPrompt: 'Prompt', documents: [], rows: [], unknown: 'x'.repeat(LIMITS.defaultsBytes) }); assert.equal(result.code, 413); assert.equal(state.puts.length, 0);
  result = await state.call({ action: 'create', name: ' ' }); assert.equal(result.code, 400); assert.equal(state.puts.length, 0);
});

test('200000-character Chinese prompts and one historical copy round-trip; over-limit saves preserve the prior version', async () => {
  const state = memory(); const project = DEFAULT_PROJECT; const prompt = '中'.repeat(200000);
  const row = sampleRow(project); row.provenance.systemPrompt = prompt;
  let result = await state.call({ action: 'save', projectId: project.id, systemPrompt: prompt, documents: [], rows: [row] });
  assert.equal(result.code, 200); const writes = state.puts.length;
  result = await state.call(null); assert.equal(result.data.defaults.systemPrompt, prompt); assert.equal(result.data.defaults.rows[0].provenance.systemPrompt, prompt);
  result = await state.call({ action: 'save', projectId: project.id, systemPrompt: prompt + '中', documents: [], rows: [] }); assert.equal(result.code, 400); assert.equal(state.puts.length, writes);
  const tooManyCopies = Array.from({ length: 6 }, (_, i) => ({ ...row, id: String(i) }));
  result = await state.call({ action: 'save', projectId: project.id, systemPrompt: prompt, documents: [], rows: tooManyCopies }); assert.equal(result.code, 413); assert.equal(state.puts.length, writes);
  result = await state.call(null); assert.equal(result.data.defaults.rows.length, 1); assert.equal(result.data.defaults.systemPrompt, prompt);
});
