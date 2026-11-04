import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDefaults } from '../lib/defaults.js';
import { createAuth } from '../lib/auth.js';

const host = 'https://test.public.blob.vercel-storage.com/';
const req = (body, id, headers = {}) => ({ method: body ? 'POST' : 'GET', url: `/api/defaults${id ? '?project=' + id : ''}`, body, headers: { host: 'localhost', origin: 'http://localhost', 'content-type': 'application/json', ...headers } });
const response = () => ({ setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } });
function setup(options = {}) {
  const files = new Map(); const puts = []; const fetched = []; let clock = 0;
  const storage = createDefaults({ getToken: () => 'test-token', getStoreId: () => '', security: { mutation() {}, requireAdmin() {} }, blob: {
    list: async ({ prefix }) => ({ blobs: Array.from(files, ([pathname, item]) => ({ pathname, url: host + pathname, uploadedAt: item.time })).filter(item => item.pathname.startsWith(prefix)), hasMore: false }),
    put: async (pathname, content, settings) => { assert.equal(settings.allowOverwrite, false); assert.equal(files.has(pathname), false); puts.push(pathname); files.set(pathname, { content, time: new Date(Date.now() + ++clock) }); },
    head: async pathname => ({ pathname, url: host + pathname, size: 4, contentType: 'application/pdf' }),
    del: async () => { assert.fail('Logical project deletion must never physically delete Blob files.'); },
  }, fetchImpl: async location => { fetched.push(location); return new Response(files.get(new URL(location).pathname.slice(1))?.content ?? '%PDF'); }, parsePDF: async () => ({ pages: 1, text: 'Text' }), ...options });
  async function call(body, id, headers) { const res = response(); await storage.handler(req(body, id, headers), res); return res; }
  return { files, puts, fetched, call, storage };
}
const save = (id, documents = []) => ({ action: 'save', projectId: id, systemPrompt: 'Project prompt', rows: [], documents });

test('deletion requires admin, same origin, valid project and an exact name confirmation', async () => {
  const unauthorized = setup({ security: createAuth(() => ({})) });
  assert.equal((await unauthorized.call({ action: 'delete', projectId: 'default', confirmName: 'Default' })).code, 401);
  assert.equal((await unauthorized.call({ action: 'delete', projectId: 'default', confirmName: 'Default' }, null, { origin: 'https://evil.test' })).code, 403); assert.equal(unauthorized.puts.length, 0);
  const state = setup(); assert.equal((await state.call({ action: 'delete', projectId: 'default', confirmName: 'Wrong' })).code, 400); assert.equal(state.puts.length, 0);
  assert.equal((await state.call({ action: 'delete', projectId: '../bad', confirmName: 'x' })).code, 400);
  assert.equal((await state.call({ action: 'delete', projectId: randomUUID(), confirmName: 'x' })).code, 404);
});

test('Default and last project can be deleted without reviving legacy data; creation works from empty', async () => {
  const state = setup(); const old = 'prompt-bench/defaults/1000-11111111-1111-4111-8111-111111111111.json'; state.files.set(old, { time: new Date(1000), content: JSON.stringify({ version: 1, systemPrompt: 'Legacy', documents: [] }) });
  await state.call(save('default')); const named = (await state.call({ action: 'create', name: 'Named' })).body.project;
  let res = await state.call({ action: 'delete', projectId: 'default', confirmName: 'Default' }); assert.equal(res.code, 200); assert.deepEqual(res.body.projects, [named]); assert.equal(state.files.has('prompt-bench/deleted-projects/default.json'), true); assert.equal(state.files.has(old), true);
  state.fetched.length = 0; res = await state.call(null); assert.equal(res.body.project.id, named.id); assert.ok(!state.fetched.includes(host + old));
  res = await state.call(null, 'default'); assert.equal(res.code, 404); assert.deepEqual(res.body.projects, [named]); assert.equal(res.body.configured, true);
  await state.call({ action: 'delete', projectId: named.id, confirmName: named.name });
  res = await state.call(null); assert.deepEqual(res.body.projects, []); assert.equal(res.body.project, null); assert.equal(res.body.defaults, null);
  assert.equal((await state.call(save('default'))).code, 404); assert.equal((await state.call(save(named.id))).code, 404);
  res = await state.call({ action: 'create', name: 'New after empty' }); assert.equal(res.code, 201); assert.equal(res.body.projects.length, 1); assert.notEqual(res.body.project.id, named.id);
});

test('a save already in flight may finish after deletion but its newer manifest cannot resurrect the project', async () => {
  let startParse; const started = new Promise(resolve => { startParse = resolve; }); let release; const paused = new Promise(resolve => { release = resolve; });
  const state = setup({ parsePDF: async () => { startParse(); await paused; return { pages: 1, text: 'Text' }; } });
  const project = (await state.call({ action: 'create', name: 'Race' })).body.project;
  const pathname = `prompt-bench/pdfs/${randomUUID()}.pdf`; const pending = state.call(save(project.id, [{ pathname, name: 'shared.pdf', selected: true }]));
  await started; assert.equal((await state.call({ action: 'delete', projectId: project.id, confirmName: project.name })).code, 200); release(); assert.equal((await pending).code, 200);
  assert.ok(state.puts.at(-1).startsWith('prompt-bench/projects/')); state.fetched.length = 0;
  const read = await state.call(null, project.id); assert.equal(read.code, 404); assert.equal(state.fetched.length, 0); assert.deepEqual((await state.call(null)).body.projects.map(item => item.id), ['default']); assert.equal((await state.call(save(project.id))).code, 404);
});

test('invalid tombstone paths are ignored and an uncommitted delete failure leaves the project readable', async () => {
  const state = setup(); state.files.set('prompt-bench/deleted-projects/default.json.extra', { time: new Date(), content: '{}' }); assert.equal((await state.call(null)).body.project.id, 'default');
  const failed = setup({ blob: { list: async () => ({ blobs: [], hasMore: false }), put: async () => { throw new Error('Write failed'); } } });
  assert.equal((await failed.call({ action: 'delete', projectId: 'default', confirmName: 'Default' })).code, 502); assert.equal((await failed.call(null)).body.project.id, 'default');
});
