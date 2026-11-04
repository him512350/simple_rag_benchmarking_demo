import { randomUUID, createHash } from 'node:crypto';
import { head, list, put, issueSignedToken } from '@vercel/blob';
import { handleUploadPresigned } from '@vercel/blob/client';
import { auth } from './auth.js';
import { apiFailure, jsonBody } from './auth.js';
import { ApiError } from './openrouter.js';
import { LIMITS } from './limits.js';
import { extractPDFText } from './pdf-text.js';
import { PROJECT_ID, DEFAULT_PROJECT, projectName, cleanRows, assertDefaultsSize } from './projects.js';
import { SAMPLE_PROMPT, SAMPLE_ROWS } from '../src/sample.js';

export const PDF_PATH = /^prompt-bench\/pdfs\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.pdf$/;
const PREFIX = 'prompt-bench/defaults/';
const PROJECT_PREFIX = 'prompt-bench/projects/';
const DELETED_PREFIX = 'prompt-bench/deleted-projects/';
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
function validateManifest(value, expectedHost, project) {
  validateInput(value);
  if (![1, 2].includes(value.version) || value.documents.some(doc => !publicURL(doc.url, doc.pathname, expectedHost) || !Number.isInteger(doc.pages) || doc.pages < 1 || doc.pages > LIMITS.pdfPages || !Number.isInteger(doc.textChars) || doc.textChars < 1 || doc.textChars > LIMITS.contextChars || !Number.isInteger(doc.size) || doc.size < 1 || doc.size > LIMITS.fileBytes) || value.documents.filter(doc => doc.selected).reduce((n, doc) => n + doc.textChars, 0) > LIMITS.contextChars) throw new ApiError(502, 'The saved project is invalid. Please ask the admin to save it again.');
  if (value.version === 2 && (value.projectId !== project.id || value.projectName !== project.name)) throw new ApiError(502, 'The saved project identity does not match its storage path.');
  const rows = value.version === 1 ? SAMPLE_ROWS.map(row => ({ ...row, status: 'queued' })) : value.rows;
  const documents = value.documents.map(doc => ({ name: doc.name, pathname: doc.pathname, url: doc.url, selected: doc.selected, size: doc.size, pages: doc.pages, textChars: doc.textChars, ...(typeof doc.sha256 === 'string' && /^[a-f0-9]{64}$/.test(doc.sha256) ? { sha256: doc.sha256 } : {}) }));
  return { version: 2, projectId: project.id, projectName: project.name, systemPrompt: value.systemPrompt, documents, rows: cleanRows(rows, project), savedAt: typeof value.savedAt === 'string' ? value.savedAt : null };
}
function projectPath(pathname) {
  const match = /^prompt-bench\/projects\/([^/]+)\/([A-Za-z0-9_-]{1,430})\/\d{1,16}-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/.exec(pathname);
  if (!match || !PROJECT_ID.test(match[1])) return null;
  try {
    const name = Buffer.from(match[2], 'base64url').toString('utf8');
    if (Buffer.from(name).toString('base64url') !== match[2] || projectName(name) !== name || match[1] === 'default' && name !== DEFAULT_PROJECT.name) return null;
    return { id: match[1], name };
  } catch { return null; }
}
function newer(left, right) {
  return !right || new Date(left.uploadedAt).getTime() > new Date(right.uploadedAt).getTime() || new Date(left.uploadedAt).getTime() === new Date(right.uploadedAt).getTime() && left.pathname > right.pathname;
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
  async function scan(prefix, signal, budget) {
    const items = []; let cursor; const seen = new Set();
    do {
      if (++budget.pages > LIMITS.blobPages) throw new ApiError(503, 'Project storage has too many listing pages. Ask the admin to archive old versions.');
      const page = await blob.list({ prefix, ...authOptions(), limit: 1000, cursor, abortSignal: signal });
      budget.entries += page.blobs.length;
      if (budget.entries > LIMITS.blobEntries) throw new ApiError(503, 'Project storage exceeds 10,000 entries. Ask the admin to archive old versions.');
      items.push(...page.blobs);
      if (page.hasMore && (!page.cursor || seen.has(page.cursor))) throw new Error('Invalid Blob pagination.');
      cursor = page.hasMore ? page.cursor : undefined; seen.add(cursor);
    } while (cursor);
    return items;
  }
  async function catalog(signal, budget) {
    const deleted = new Set();
    for (const item of await scan(DELETED_PREFIX, signal, budget)) {
      const id = item.pathname.slice(DELETED_PREFIX.length, -5);
      if (item.pathname === `${DELETED_PREFIX}${id}.json` && PROJECT_ID.test(id)) deleted.add(id);
    }
    const projects = new Map(deleted.has('default') ? [] : [[DEFAULT_PROJECT.id, { ...DEFAULT_PROJECT, latest: null }]]);
    for (const item of await scan(PROJECT_PREFIX, signal, budget)) {
      const project = projectPath(item.pathname); if (!project || deleted.has(project.id)) continue;
      if (!Number.isFinite(new Date(item.uploadedAt).getTime())) throw new Error('Invalid version upload date.');
      const previous = projects.get(project.id);
      if (!previous || newer(item, previous.latest)) projects.set(project.id, { ...project, latest: item });
      if (projects.size > LIMITS.projects) throw new ApiError(503, 'Project storage exceeds the 50-project limit.');
    }
    return projects;
  }
  const projectList = projects => Array.from(projects.values(), ({ id, name }) => ({ id, name })).sort((a, b) => a.id === 'default' ? -1 : b.id === 'default' ? 1 : a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  async function read(signal, id) {
    const budget = { entries: 0, pages: 0 }; const projects = await catalog(signal, budget); const available = projectList(projects);
    const chosen = id ?? available[0]?.id; const project = chosen ? projects.get(chosen) : null;
    if (id != null && !project) { const error = new ApiError(404, 'Project not found or deleted.'); error.projects = available; throw error; }
    if (!project) return { projects: available, project: null, defaults: null };
    let newest = project.latest;
    if (!newest && project.id === 'default') {
      for (const item of await scan(PREFIX, signal, budget)) {
        if (!VERSION_PATH.test(item.pathname)) continue;
        if (!Number.isFinite(new Date(item.uploadedAt).getTime())) throw new Error('Invalid version upload date.');
        if (newer(item, newest)) newest = item;
      }
    }
    let defaults = null;
    if (newest) {
      if (!publicURL(newest.url, newest.pathname)) throw new Error('Invalid manifest URL.');
      const bytes = await download(newest.url, LIMITS.defaultsBytes, fetchImpl, signal);
      const value = JSON.parse(new TextDecoder().decode(bytes));
      if (project.latest && value.version !== 2 || !project.latest && value.version !== 1) throw new ApiError(502, 'The saved project version is invalid.');
      defaults = validateManifest(value, new URL(newest.url).hostname, project);
    }
    return { projects: available, project: { id: project.id, name: project.name }, defaults };
  }
  async function commit(project, manifest, signal) {
    assertDefaultsSize(manifest);
    if (signal.aborted) throw new Error('Save timed out.');
    const name = Buffer.from(project.name).toString('base64url');
    await blob.put(`${PROJECT_PREFIX}${project.id}/${name}/${Date.now()}-${randomUUID()}.json`, JSON.stringify(manifest), { access: 'public', contentType: 'application/json', addRandomSuffix: false, allowOverwrite: false, ...authOptions(), abortSignal: signal });
  }
  async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (!['GET', 'POST'].includes(req.method)) { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ error: 'Use GET or POST.' }); }
    const signal = AbortSignal.timeout(55000);
    try {
      if (req.method === 'GET') {
        const id = new URL(req.url || '/', 'http://localhost').searchParams.get('project');
        if (id != null && !PROJECT_ID.test(id)) throw new ApiError(400, 'Invalid project ID.');
        if (!configured()) {
          if (id != null && id !== 'default') throw new ApiError(503, 'Project storage is not configured.');
          return res.status(200).json({ configured: false, projects: [{ ...DEFAULT_PROJECT }], project: { ...DEFAULT_PROJECT }, defaults: null });
        }
        return res.status(200).json({ configured: true, ...await read(signal, id) });
      }
      security.mutation(req); security.requireAdmin(req);
      const body = jsonBody(req, LIMITS.defaultsBytes); const projects = await catalog(signal, { entries: 0, pages: 0 });
      if (body.action === 'create') {
        if (projects.size >= LIMITS.projects) throw new ApiError(400, 'Create at most 50 projects.');
        const project = { id: randomUUID(), name: projectName(body.name) };
        const manifest = { version: 2, projectId: project.id, projectName: project.name, systemPrompt: SAMPLE_PROMPT, documents: [], rows: cleanRows(SAMPLE_ROWS.map(row => ({ ...row, status: 'queued' })), project), savedAt: new Date().toISOString() };
        await commit(project, manifest, signal); projects.set(project.id, project);
        return res.status(201).json({ project, projects: projectList(projects), defaults: manifest });
      }
      if (body.action != null && !['save', 'delete'].includes(body.action)) throw new ApiError(400, 'Choose create, save or delete.');
      if (!PROJECT_ID.test(body.projectId || '')) throw new ApiError(400, 'Select a valid project before saving. Refresh the app.');
      const selected = projects.get(body.projectId);
      if (!selected) throw new ApiError(404, 'Project not found.');
      const project = { id: selected.id, name: selected.name };
      if (body.action === 'delete') {
        if (body.confirmName !== project.name) throw new ApiError(400, 'The project name confirmation does not match.');
        await blob.put(`${DELETED_PREFIX}${project.id}.json`, JSON.stringify({ version: 1, projectId: project.id, projectName: project.name, deletedAt: new Date().toISOString() }), { access: 'public', contentType: 'application/json', addRandomSuffix: false, allowOverwrite: false, ...authOptions(), abortSignal: signal });
        projects.delete(project.id);
        return res.status(200).json({ projects: projectList(projects) });
      }
      validateInput(body); const rows = cleanRows(body.rows, project); const documents = [];
      for (const doc of body.documents) {
        const info = await blob.head(doc.pathname, { ...authOptions(), abortSignal: signal });
        if (info.pathname !== doc.pathname || !publicURL(info.url, doc.pathname) || info.contentType?.split(';')[0] !== 'application/pdf' || info.size < 1 || info.size > LIMITS.fileBytes) throw new ApiError(400, 'A PDF is missing, not public, or exceeds the 5 MB limit.');
        const bytes = await download(info.url, LIMITS.fileBytes, fetchImpl, signal); const size = bytes.byteLength;
        let parsed;
        try { parsed = await parsePDF(bytes, signal); } catch (error) { throw new ApiError(400, `Could not save ${doc.name}: ${error.message}`); }
        if (signal.aborted) throw new Error('Save timed out.');
        documents.push({ name: doc.name, pathname: doc.pathname, url: info.url, selected: doc.selected, size, pages: parsed.pages, textChars: parsed.text.length, sha256: createHash('sha256').update(parsed.text).digest('hex') });
      }
      const manifest = validateManifest({ version: 2, projectId: project.id, projectName: project.name, systemPrompt: body.systemPrompt, documents, rows, savedAt: new Date().toISOString() }, undefined, project);
      await commit(project, manifest, signal);
      return res.status(200).json({ project, projects: projectList(projects), defaults: manifest });
    } catch (error) {
      if (error instanceof ApiError && error.status === 404 && error.projects) return res.status(404).json({ error: error.message, configured: true, projects: error.projects });
      return apiFailure(res, error, 'Could not confirm the project. Retry or reload to check the latest saved version.');
    }
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
