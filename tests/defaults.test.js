import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaults } from '../lib/defaults.js';
import { createAuth } from '../lib/auth.js';
import { ApiError } from '../lib/openrouter.js';
const path = 'prompt-bench/pdfs/11111111-1111-4111-8111-111111111111.pdf';
const url = pathname => `https://test.public.blob.vercel-storage.com/${pathname}`;
const input = () => ({ systemPrompt: 'Shared prompt', documents: [{ name: 'policy.pdf', pathname: path, selected: true, pages: 999, textChars: -1, url: 'https://evil.test' }] });
const request = (body, method = 'POST') => ({ method, body, headers: { host: 'localhost', origin: 'http://localhost', 'content-type': 'application/json' } });
function response() { return { headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(v) { this.code = v; return this; }, json(v) { this.body = v; return this; } }; }
const security = { mutation() {}, requireAdmin() {} };
function setup(overrides = {}) {
  const commits = []; const fetched = [];
  const storage = createDefaults({ getToken: () => 'test-token', security, blob: { head: async pathname => ({ pathname, url: url(pathname), contentType: 'application/pdf', size: 4 }), list: async () => ({ blobs: [], hasMore: false }), put: async (...args) => { commits.push(args); } }, fetchImpl: async location => { fetched.push(location); return new Response('%PDF'); }, parsePDF: async () => ({ pages: 2, text: 'Actual parsed text.' }), ...overrides });
  return { storage, commits, fetched };
}
test('server trusts canonical head URL and parsed PDF, never client claims; immutable last commit', async () => {
  const { storage, commits, fetched } = setup(); const res = response(); await storage.handler(request(input()), res); assert.equal(res.code, 200); assert.equal(commits.length, 1); assert.match(commits[0][0], /^prompt-bench\/defaults\/\d+-[\da-f-]+\.json$/);
  assert.deepEqual(fetched, [url(path)]); assert.equal(res.body.defaults.documents[0].pages, 2); assert.equal(res.body.defaults.documents[0].textChars, 19); assert.equal(res.body.defaults.documents[0].url, url(path)); assert.ok(!JSON.stringify(res.body).includes('evil.test')); assert.equal(commits[0][2].allowOverwrite, false); assert.ok(!JSON.stringify(res.body.defaults).includes('Actual parsed text.'));
});
test('unauthenticated and cross-origin writes do not touch storage', async () => {
  const auth = createAuth(() => ({})); const { storage, commits } = setup({ security: auth });
  let res = response(); await storage.handler(request(input()), res); assert.equal(res.code, 401);
  res = response(); const bad = request(input()); bad.headers.origin = 'https://evil.test'; await storage.handler(bad, res); assert.equal(res.code, 403); assert.equal(commits.length, 0);
});
test('invalid namespace, PDF parse, size, content type, redirects and selected total fail before commit', async () => {
  const cases = [
    { body: { ...input(), documents: [{ ...input().documents[0], pathname: 'other-store/path.pdf' }] } },
    { options: { parsePDF: async () => { throw new Error('Scanned page has no text.'); } } },
    { options: { fetchImpl: async () => new Response('redirect', { status: 302 }) } },
    { options: { fetchImpl: async () => new Response('small', { headers: { 'Content-Length': '99999999' } }) } },
    { options: { parsePDF: async () => ({ pages: 11, text: 'x' }) } },
    { options: { blob: { head: async () => ({ pathname: path, url: 'https://evil.test', contentType: 'application/pdf', size: 4 }) } } },
  ];
  for (const item of cases) { const { storage, commits } = setup(item.options); const res = response(); await storage.handler(request(item.body || input()), res); assert.ok(res.code >= 400); assert.equal(commits.length, 0); }
});
test('public read paginates and sorts uploadedAt then pathname, not listing order', async () => {
  const old = 'prompt-bench/defaults/1000-11111111-1111-4111-8111-111111111111.json'; const winner = 'prompt-bench/defaults/2000-ffffffff-ffff-4fff-8fff-ffffffffffff.json'; const tie = 'prompt-bench/defaults/2000-11111111-1111-4111-8111-111111111111.json';
  const calls = []; const manifest = { version: 1, systemPrompt: 'Newest', documents: [], savedAt: 'today' };
  const { storage } = setup({ blob: { list: async ({ cursor }) => { calls.push(cursor); return cursor ? { blobs: [{ pathname: winner, url: url(winner), uploadedAt: new Date(2000) }, { pathname: old, url: url(old), uploadedAt: new Date(1000) }], hasMore: false } : { blobs: [{ pathname: tie, url: url(tie), uploadedAt: new Date(2000) }], hasMore: true, cursor: 'next' }; } }, fetchImpl: async location => { assert.equal(location, url(winner)); return Response.json(manifest); } });
  const res = response(); await storage.handler(request(null, 'GET'), res); assert.equal(res.code, 200); assert.equal(res.body.defaults.systemPrompt, 'Newest'); assert.deepEqual(calls, [undefined, 'next']);
});
test('unconfigured/empty store fallback, read failure stays an error', async () => {
  let res = response(); await setup({ getToken: () => '' }).storage.handler(request(null, 'GET'), res); assert.deepEqual(res.body, { configured: false, defaults: null });
  res = response(); await setup().storage.handler(request(null, 'GET'), res); assert.deepEqual(res.body, { configured: true, defaults: null });
  res = response(); await setup({ blob: { list: async () => { throw new Error('network'); } } }).storage.handler(request(null, 'GET'), res); assert.equal(res.code, 502);
});
test('upload token validates session/origin/path and caps; completion relies on SDK verification', async () => {
  let options; const storage = setup({ upload: async opts => { options = opts; if (opts.body.type === 'blob.generate-client-token') return opts.onBeforeGenerateToken(opts.body.payload.pathname); await opts.onUploadCompleted({}); return { ok: true }; } }).storage;
  let res = response(); await storage.uploadHandler(request({ type: 'blob.generate-client-token', payload: { pathname: path } }), res); assert.equal(res.code, 200); assert.equal(res.body.maximumSizeInBytes, 5 * 1024 * 1024); assert.equal(res.body.allowOverwrite, false); assert.deepEqual(res.body.allowedContentTypes, ['application/pdf']); assert.ok(res.body.validUntil <= Date.now() + 300000);
  res = response(); await storage.uploadHandler(request({ type: 'blob.generate-client-token', payload: { pathname: 'bad' } }), res); assert.equal(res.code, 400);
  const noSession = setup({ security: { mutation() { throw new ApiError(403, 'Origin'); }, requireAdmin() { throw new ApiError(401, 'Login'); } }, upload: async opts => { await opts.onUploadCompleted({}); return { ok: true }; } }).storage;
  res = response(); await noSession.uploadHandler(request({ type: 'blob.upload-completed' }), res); assert.equal(res.code, 200);
});
test('failed commit performs no deletion and does not falsely promise an unchanged version', async () => {
  const { storage } = setup({ blob: { head: async pathname => ({ pathname, url: url(pathname), contentType: 'application/pdf', size: 4 }), put: async () => { throw new Error('Ack lost'); } } });
  const res = response(); await storage.handler(request(input()), res); assert.equal(res.code, 502); assert.match(res.body.error, /Retry or reload/); assert.ok(!res.body.error.includes('were not changed'));
});

test('upload generation uses real session/origin checks; unsigned real SDK completion is rejected', async () => {
  const realAuth = createAuth(() => ({}));
  const fakeSDK = async options => options.onBeforeGenerateToken(options.body.payload.pathname);
  const storage = setup({ security: realAuth, upload: fakeSDK }).storage;
  const body = { type: 'blob.generate-client-token', payload: { pathname: path } };
  let res = response(); await storage.uploadHandler(request(body), res); assert.equal(res.code, 401);
  res = response(); const bad = request(body); bad.headers.origin = 'https://evil.test'; await storage.uploadHandler(bad, res); assert.equal(res.code, 403);
  const realSDK = createDefaults({ getToken: () => 'vercel_blob_rw_teststore_faketoken', security: realAuth });
  res = response(); await realSDK.uploadHandler(request({ type: 'blob.upload-completed', payload: {} }), res); assert.ok(res.code >= 400);
});

test('real Node PDF.js parser validates a PDF and preserves its size after buffer transfer', async () => {
  let pdf = '%PDF-1.4\n'; const offsets = [0]; const stream = 'BT /F1 24 Tf 72 720 Td (Actual policy text) Tj ET\n';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf); pdf += 'xref\n0 6\n0000000000 65535 f \n' + offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('') + `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  let committed; const storage = createDefaults({ getToken: () => 'token', security, blob: { head: async pathname => ({ pathname, url: url(pathname), contentType: 'application/pdf', size: Buffer.byteLength(pdf) }), put: async (pathname, value) => { committed = JSON.parse(value); } }, fetchImpl: async () => new Response(pdf) });
  const res = response(); await storage.handler(request(input()), res); assert.equal(res.code, 200); assert.equal(committed.documents[0].size, Buffer.byteLength(pdf)); assert.equal(committed.documents[0].pages, 1); assert.equal(committed.documents[0].textChars, 18);
});
