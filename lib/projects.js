import { LIMITS, utf8Bytes } from './limits.js';
import { ApiError } from './openrouter.js';

export const PROJECT_ID = /^(?:default|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
export const DEFAULT_PROJECT = Object.freeze({ id: 'default', name: 'Default' });
export function projectName(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80 || /[\u0000-\u001f\u007f]/.test(value)) throw new ApiError(400, 'Project name must contain 1–80 characters without control characters.');
  return value.trim();
}
function text(value, maximum, label, required = false) {
  if (typeof value !== 'string' || value.length > maximum || required && !value.trim()) throw new ApiError(400, `Invalid ${label}.`);
  return value;
}
function metric(value, label) {
  if (value == null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new ApiError(400, `Invalid ${label}.`);
  return value;
}
export function cleanRows(rows, project) {
  if (!Array.isArray(rows) || rows.length > LIMITS.cases) throw new ApiError(400, 'Save at most 50 benchmark cases. Refresh the app if the cases are missing.');
  const ids = new Set();
  return rows.map(row => {
    if (!row || typeof row !== 'object' || !['queued', 'done', 'error'].includes(row.status)) throw new ApiError(400, 'Invalid benchmark case status.');
    const id = text(row.id, 80, 'case ID', true); if (ids.has(id)) throw new ApiError(400, 'Case IDs must be unique.'); ids.add(id);
    const input = text(row.input, LIMITS.questionChars, 'question', true);
    const base = { id, input, status: row.status, response: '', error: '', elapsedMs: null, usage: null, truncated: false };
    if (row.status === 'queued') return base;
    const source = row.provenance;
    if (!source || source.projectId !== project.id || source.projectName !== project.name) throw new ApiError(400, 'Each completed case needs its original project and run details.');
    const runAt = text(source.runAt, 30, 'run date', true);
    if (!Number.isFinite(Date.parse(runAt)) || new Date(runAt).toISOString() !== runAt) throw new ApiError(400, 'Invalid run date.');
    if (!Array.isArray(source.documentNames) || source.documentNames.length > LIMITS.files || !Array.isArray(source.documentFingerprints) || source.documentFingerprints.length !== source.documentNames.length) throw new ApiError(400, 'Invalid run document details.');
    const documentNames = source.documentNames.map(name => text(name, 255, 'run document name', true));
    const documentFingerprints = source.documentFingerprints.map((doc, i) => {
      if (!doc || doc.name !== documentNames[i] || typeof doc.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(doc.sha256) || doc.pathname != null && !/^prompt-bench\/pdfs\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.pdf$/.test(doc.pathname)) throw new ApiError(400, 'Invalid run document fingerprint.');
      return { name: doc.name, sha256: doc.sha256, pathname: doc.pathname ?? null };
    });
    let usage = null;
    if (row.usage != null) {
      if (typeof row.usage !== 'object' || Array.isArray(row.usage)) throw new ApiError(400, 'Invalid token usage.');
      usage = Object.fromEntries(['prompt_tokens', 'completion_tokens', 'total_tokens'].map(key => [key, metric(row.usage[key], 'token usage')]));
    }
    if (typeof row.truncated !== 'boolean') throw new ApiError(400, 'Invalid truncation flag.');
    return { ...base, response: text(row.response, LIMITS.responseChars, 'response', row.status === 'done'), error: text(row.error, LIMITS.errorChars, 'error', row.status === 'error'), elapsedMs: metric(row.elapsedMs, 'elapsed time'), usage, truncated: row.truncated,
      provenance: { projectId: project.id, projectName: project.name, model: text(source.model, 200, 'run model', true), systemPrompt: text(source.systemPrompt, LIMITS.systemChars, 'run prompt', true), documentNames, documentFingerprints, runAt } };
  });
}
export function assertDefaultsSize(value) {
  if (utf8Bytes(JSON.stringify(value)) > LIMITS.defaultsBytes) throw new ApiError(413, 'Project data exceeds the 3 MiB limit. Use fewer or shorter saved results.');
}
