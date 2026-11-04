import { randomUUID } from 'node:crypto';
import { head, list, put, issueSignedToken } from '@vercel/blob';
import { handleUploadPresigned } from '@vercel/blob/client';
import { auth } from './auth.js';
import { apiFailure, jsonBody } from './auth.js';
import { ApiError } from './openrouter.js';
import { LIMITS } from './limits.js';
import { extractPDFText } from './pdf-text.js';

export const PDF_PATH = /^prompt-bench\/pdfs\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.pdf$/;
const PREFIX = 'prompt-bench/defaults/';
const VERSION_PATH = /^prompt-bench\/defaults\/\d+-[0-9a-f-]{36}\.json$/;
function publicURL(url, pathname, expectedHost) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && /^[a-z0-9-]+\.public\.blob\.vercel-storage\.com$/.test(parsed.hostname) && parsed.pathname === '/' + pathname && !parsed.search && !parsed.hash && !parsed.username && !parsed.password && !parsed.port && (!expectedHost || parsed.hostname === expectedHost);
  } catch { return false; }
}
async function download(url, maxBytes, fetchImpl, signal) {
  const response = await fetchImpl(url, { redirect: 'error', cache: 'no-store', signal });
  if (response.status !== 200 || response.url && response.url !== url) throw new ApiError(502, 'A saved file could not be downloaded. Shared defaults were not changed.');
  if (Number(response.headers.get('content-length')) > maxBytes) throw new ApiError(413, 'A saved file exceeds the size limit.');
  const reader = response.body.getReader(); const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new ApiError(413, 'A saved file exceeds the size limit.');
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const result = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}
function validateInput(body) {
  if (typeof body.systemPrompt !== 'string' || !body.systemPrompt.trim() || body.systemPrompt.length > LIMITS.systemChars) throw new ApiError(400, 'System prompt must contain 1–12,000 characters.');
  if (!Array.isArray(body.documents) || body.documents.length > LIMITS.files) throw new ApiError(400, 'Save at most 10 PDF documents.');
  const paths = new Set();
  for (const doc of body.documents) {
    if (!doc || !PDF_PATH.test(doc.pathname) || typeof doc.name !== 'string' || !doc.name.trim() || doc.name.length > 255 || !/\.pdf$/i.test(doc.name) || typeof doc.selected !== 'boolean' || paths.has(doc.pathname)) throw new ApiError(400, 'Invalid PDF document details.');
    paths.add(doc.pathname);
  }
  return body;
}
function validateManifest(value, expectedHost) {
  validateInput(value);
  if (value.version !== 1 || value.documents.some(doc => !publicURL(doc.url, doc.pathname, expectedHost) || !Number.isInteger(doc.pages) || doc.pages < 1 || doc.pages > LIMITS.pdfPages || !Number.isInteger(doc.textChars) || doc.textChars < 1 || doc.textChars > LIMITS.contextChars || !Number.isInteger(doc.size) || doc.size < 1 || doc.size > LIMITS.fileBytes) || value.documents.filter(doc => doc.selected).reduce((n, doc) => n + doc.textChars, 0) > LIMITS.contextChars) throw new ApiError(502, 'The saved defaults are invalid. Please ask the admin to save them again.');
  return value;
}
export function createDefaults({ blob = { head, list, put }, upload = handleUploadPresigned, issueToken = issueSignedToken, security = auth, getToken = () => process.env.BLOB_READ_WRITE_TOKEN, getStoreId = () => process.env.BLOB_STORE_ID, getWebhookKey = () => process.env.BLOB_WEBHOOK_PUBLIC_KEY, fetchImpl = fetch, parsePDF = async (bytes, signal) => extractPDFText(bytes, (await import('pdfjs-dist/legacy/build/pdf.mjs')).getDocument, signal) } = {}) {
  function configured() { return Boolean(getStoreId()?.trim() || getToken()?.trim()); }
  function authOptions() {
    const storeId = getStoreId()?.trim();
    if (storeId) return { storeId }; // The SDK resolves and refreshes Vercel request-context OIDC credentials.
    const token = getToken()?.trim();
    if (token) return { token };
    throw new ApiError(503, 'Shared defaults are not configured. Connect a public Vercel Blob store to this project.');
  }
  async function read(signal) {
    const storageAuth = authOptions(); let cursor; let newest = null;
    do {
      const page = await blob.list({ prefix: PREFIX, ...storageAuth, cursor, abortSignal: signal });
      for (const item of page.blobs) {
        if (!VERSION_PATH.test(item.pathname)) continue;
        if (!newest || new Date(item.uploadedAt).getTime() > new Date(newest.uploadedAt).getTime() || new Date(item.uploadedAt).getTime() === new Date(newest.uploadedAt).getTime() && item.pathname > newest.pathname) newest = item;
      }
      if (page.hasMore && !page.cursor) throw new Error('Invalid Blob pagination.');
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    if (!newest) return null;
    if (!publicURL(newest.url, newest.pathname)) throw new Error('Invalid manifest URL.');
    const bytes = await download(newest.url, LIMITS.requestBytes, fetchImpl, signal);
    return validateManifest(JSON.parse(new TextDecoder().decode(bytes)), new URL(newest.url).hostname);
  }
  async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (!['GET', 'POST'].includes(req.method)) { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ error: 'Use GET or POST.' }); }
    const signal = AbortSignal.timeout(55000);
    try {
      if (req.method === 'GET') {
        if (!configured()) return res.status(200).json({ configured: false, defaults: null });
        return res.status(200).json({ configured: true, defaults: await read(signal) });
      }
      security.mutation(req); security.requireAdmin(req);
      const body = validateInput(jsonBody(req)); const storageAuth = authOptions(); const documents = [];
      for (const doc of body.documents) {
        const info = await blob.head(doc.pathname, { ...storageAuth, abortSignal: signal });
        if (info.pathname !== doc.pathname || !publicURL(info.url, doc.pathname) || info.contentType?.split(';')[0] !== 'application/pdf' || info.size < 1 || info.size > LIMITS.fileBytes) throw new ApiError(400, 'A PDF is missing, not public, or exceeds the 5 MB limit.');
        const bytes = await download(info.url, LIMITS.fileBytes, fetchImpl, signal);
        const size = bytes.byteLength;
        let parsed;
        try { parsed = await parsePDF(bytes, signal); } catch (error) { throw new ApiError(400, `Could not save ${doc.name}: ${error.message}`); }
        if (signal.aborted) throw new Error('Save timed out.');
        documents.push({ name: doc.name, pathname: doc.pathname, url: info.url, selected: doc.selected, size, pages: parsed.pages, textChars: parsed.text.length });
      }
      const manifest = validateManifest({ version: 1, systemPrompt: body.systemPrompt, documents, savedAt: new Date().toISOString() });
      if (signal.aborted) throw new Error('Save timed out.');
      await blob.put(`${PREFIX}${Date.now()}-${randomUUID()}.json`, JSON.stringify(manifest), { access: 'public', contentType: 'application/json', addRandomSuffix: false, allowOverwrite: false, ...storageAuth, abortSignal: signal });
      return res.status(200).json({ defaults: manifest });
    } catch (error) { return apiFailure(res, error, 'Could not confirm the shared defaults. Retry or reload to check the latest saved version.'); }
  }
  async function uploadHandler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Use POST.' }); }
    try {
      const body = jsonBody(req, 16384);
      if (!['blob.generate-presigned-url', 'blob.upload-completed'].includes(body.type)) throw new ApiError(400, 'Invalid upload request.');
      const webhookPublicKey = getWebhookKey()?.trim();
      if (!webhookPublicKey) throw new ApiError(503, 'PDF uploads are not configured. Connect the Blob store so BLOB_WEBHOOK_PUBLIC_KEY is available.');
      const result = await upload({ body, request: req, webhookPublicKey, getSignedToken: async (pathname, clientPayload, multipart) => {
        security.mutation(req); security.requireAdmin(req);
        if (!PDF_PATH.test(pathname) || multipart) throw new ApiError(400, 'Invalid PDF upload path or mode.');
        const token = await issueToken({ ...authOptions(), pathname, operations: ['put'], allowedContentTypes: ['application/pdf'], maximumSizeInBytes: LIMITS.fileBytes, validUntil: Date.now() + 5 * 60 * 1000 });
        return { token, urlOptions: { access: 'public', contentType: 'application/pdf', addRandomSuffix: false, allowOverwrite: false } };
      }, onUploadCompleted: async () => {} });
      return res.status(200).json(result);
    } catch (error) { return apiFailure(res, error, 'The PDF upload could not be authorized. Try again.'); }
  }
  return { handler, uploadHandler, read };
}
export const defaults = createDefaults();
