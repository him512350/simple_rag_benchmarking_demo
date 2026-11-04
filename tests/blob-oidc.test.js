import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { createDefaults } from '../lib/defaults.js';
import { createAuth } from '../lib/auth.js';

const pdfPath = 'prompt-bench/pdfs/11111111-1111-4111-8111-111111111111.pdf';
const publicURL = pathname => `https://test.public.blob.vercel-storage.com/${pathname}`;
const security = { mutation() {}, requireAdmin() {} };
const request = (body, method = 'POST') => ({ method, body, headers: { host: 'localhost', origin: 'http://localhost', 'content-type': 'application/json' } });
function response() { return { headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } }; }

test('real Blob SDK resolves request-context OIDC for list, head, put and presigned PDF grants without legacy token', async () => {
  const dispatcher = getGlobalDispatcher(); const agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent);
  const symbol = Symbol.for('@vercel/request-context'); const previousContext = globalThis[symbol];
  const oidc = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.test-signature`;
  globalThis[symbol] = { get: () => ({ headers: { 'x-vercel-oidc-token': oidc } }) };
  const pool = agent.get('https://vercel.com'); const calls = []; const manifests = new Map();
  const record = options => { const headers = new Headers(options.headers); assert.equal(headers.get('authorization'), `Bearer ${oidc}`); assert.equal(headers.get('x-vercel-blob-store-id'), 'test'); calls.push(options); };
  pool.intercept({ path: /^\/api\/blob\?/, method: 'GET' }).reply(options => {
    record(options); const parsed = new URL(options.path, 'https://vercel.com'); const pathname = parsed.searchParams.get('url');
    if (pathname) return { statusCode: 200, data: { pathname, url: publicURL(pathname), contentType: 'application/pdf', size: 4, uploadedAt: new Date().toISOString() } };
    return { statusCode: 200, data: { blobs: Array.from(manifests.keys()).map(pathname => ({ pathname, url: publicURL(pathname), uploadedAt: new Date().toISOString() })), hasMore: false } };
  }).persist();
  pool.intercept({ path: /^\/api\/blob\/\?pathname=/, method: 'PUT' }).reply(options => {
    record(options); const pathname = new URL(options.path, 'https://vercel.com').searchParams.get('pathname'); manifests.set(pathname, JSON.parse(options.body));
    return { statusCode: 200, data: { pathname, url: publicURL(pathname), contentType: 'application/json' } };
  }).persist();
  pool.intercept({ path: '/api/blob/signed-token', method: 'POST' }).reply(options => {
    record(options); const scope = JSON.parse(options.body); assert.equal(scope.pathname, pdfPath); assert.deepEqual(scope.operations, ['put']); assert.deepEqual(scope.allowedContentTypes, ['application/pdf']); assert.equal(scope.maximumSizeInBytes, 5242880);
    return { statusCode: 200, data: { delegationToken: Buffer.from(JSON.stringify({ ...scope, storeId: 'test' })).toString('base64url') + '.mock-signature', clientSigningToken: Buffer.from('test-signing-key-only').toString('base64url'), validUntil: scope.validUntil } };
  });
  const { publicKey } = generateKeyPairSync('ed25519');
  const storage = createDefaults({ getToken: () => '', getStoreId: () => 'store_test', getWebhookKey: () => publicKey.export({ type: 'spki', format: 'pem' }), security,
    fetchImpl: async location => { const pathname = new URL(location).pathname.slice(1); return manifests.has(pathname) ? Response.json(manifests.get(pathname)) : new Response('%PDF'); },
    parsePDF: async () => ({ pages: 1, text: 'Actual text' }),
  });
  try {
    let res = response(); await storage.handler(request(null, 'GET'), res); assert.equal(res.code, 200); assert.equal(res.body.configured, true); assert.equal(res.body.defaults, null);
    res = response(); await storage.handler(request({ projectId: 'default', rows: [], systemPrompt: 'Saved through OIDC', documents: [{ name: 'policy.pdf', pathname: pdfPath, selected: true }] }), res); assert.equal(res.code, 200); assert.equal(res.body.defaults.documents[0].pages, 1);
    res = response(); await storage.handler(request(null, 'GET'), res); assert.equal(res.code, 200); assert.equal(res.body.defaults.systemPrompt, 'Saved through OIDC');
    res = response(); await storage.uploadHandler(request({ type: 'blob.generate-presigned-url', payload: { pathname: pdfPath, multipart: false } }), res); assert.equal(res.code, 200); assert.ok(res.body.presignedUrlPayload.delegationToken); assert.equal(res.body.presignedUrlPayload.params['vercel-blob-allow-overwrite'], 'false');
    assert.equal(calls.filter(call => call.method === 'GET').length, 5); assert.equal(calls.filter(call => call.method === 'PUT').length, 1); assert.equal(calls.filter(call => call.path.endsWith('/signed-token')).length, 1);
  } finally { globalThis[symbol] = previousContext; setGlobalDispatcher(dispatcher); await agent.close(); }
});

test('presigned callback verifies Ed25519 key independently of store credentials and admin session', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const storage = createDefaults({ getToken: () => '', getStoreId: () => '', getWebhookKey: () => publicKey.export({ type: 'spki', format: 'pem' }), security: createAuth(() => ({})) });
  const body = { type: 'blob.upload-completed', payload: { blob: { pathname: pdfPath }, tokenPayload: null } };
  const req = request(body); delete req.headers.origin; req.headers['x-vercel-signature'] = sign(null, Buffer.from(JSON.stringify(body)), privateKey).toString('hex');
  let res = response(); await storage.uploadHandler(req, res); assert.equal(res.code, 200); assert.equal(res.body.response, 'ok');
  res = response(); req.headers['x-vercel-signature'] = '00'.repeat(64); await storage.uploadHandler(req, res); assert.ok(res.code >= 400);
});

test('connected store auth errors remain errors and manifest documents cannot point at a different store', async () => {
  const storage = createDefaults({ getToken: () => '', getStoreId: () => 'store_test', blob: { list: async () => { throw new Error('OIDC permission denied'); } } });
  let res = response(); await storage.handler(request(null, 'GET'), res); assert.equal(res.code, 502); assert.equal(res.body.configured, undefined);
  const pathname = 'prompt-bench/defaults/1000-11111111-1111-4111-8111-111111111111.json';
  const otherStore = createDefaults({ getStoreId: () => 'store_test', getToken: () => '', blob: { list: async () => ({ blobs: [{ pathname, url: publicURL(pathname), uploadedAt: new Date() }], hasMore: false }) }, fetchImpl: async () => Response.json({ version: 1, systemPrompt: 'Prompt', documents: [{ name: 'policy.pdf', pathname: pdfPath, url: `https://other.public.blob.vercel-storage.com/${pdfPath}`, pages: 1, textChars: 4, size: 4, selected: true }] }) });
  res = response(); await otherStore.handler(request(null, 'GET'), res); assert.ok(res.code >= 400);
});
