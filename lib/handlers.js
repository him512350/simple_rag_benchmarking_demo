import { resultMetadata } from './result-metadata.js';
import { ApiError, openRouter } from './openrouter.js';
import { LIMITS, utf8Bytes } from './limits.js';

export function validateBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'Send a JSON object.');
  if (utf8Bytes(JSON.stringify(body)) > LIMITS.requestBytes) throw new ApiError(413, 'Request is too large (maximum 256 KB).');
  const { model, systemPrompt, question, documents } = body;
  if (typeof model !== 'string' || !model || model.length > 200) throw new ApiError(400, 'Select a model.');
  if (typeof systemPrompt !== 'string' || !systemPrompt.trim() || systemPrompt.length > LIMITS.systemChars) throw new ApiError(400, 'System prompt must contain 1–12,000 characters.');
  if (typeof question !== 'string' || !question.trim() || question.length > LIMITS.questionChars) throw new ApiError(400, 'Question must contain 1–4,000 characters.');
  if (!Array.isArray(documents) || documents.length > LIMITS.files) throw new ApiError(400, 'Select at most 10 documents.');
  if (documents.some(doc => !doc || typeof doc.name !== 'string' || !doc.name.trim() || doc.name.length > 255 || typeof doc.text !== 'string' || !doc.text.trim())) throw new ApiError(400, 'Each document needs a name and extracted text.');
  if (documents.reduce((count, doc) => count + doc.text.length, 0) > LIMITS.contextChars) throw new ApiError(400, 'Selected documents exceed 60,000 characters.');
  return { model, systemPrompt, question, documents: documents.map(({ name, text }) => ({ name, text })) };
}

function sendError(res, error) {
  const known = error instanceof ApiError;
  const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
  return res.status(known ? error.status : timedOut ? 504 : 502).json({ error: known ? error.message : timedOut ? 'The request timed out or was cancelled. Retry this case.' : 'Could not reach OpenRouter. Try again.', ...(known && error.result ? { result: resultMetadata(error.result) } : {}) });
}

export function createHandlers(service = openRouter, getKey = () => process.env.OPENROUTER_API_KEY) {
  function requireKey() {
    const key = getKey()?.trim();
    if (!key) throw new ApiError(503, 'OpenRouter is not configured. Set OPENROUTER_API_KEY on the server.');
    return key;
  }
  async function models(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'Use GET.' }); }
    try {
      requireKey();
      return res.status(200).json({ models: await service.models() });
    } catch (error) { return sendError(res, error); }
  }
  async function benchmark(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Use POST.' }); }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), 55000);
    const disconnect = () => { if (!res.writableEnded) controller.abort(); };
    res.on?.('close', disconnect);
    req.on?.('aborted', disconnect);
    try {
      const key = requireKey();
      if (Number(req.headers?.['content-length']) > LIMITS.requestBytes) throw new ApiError(413, 'Request is too large (maximum 256 KB).');
      if (!req.headers?.['content-type']?.toLowerCase().startsWith('application/json')) throw new ApiError(415, 'Use Content-Type: application/json.');
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch { throw new ApiError(400, 'Invalid JSON body.'); } }
      const validated = validateBody(body);
      return res.status(200).json(await service.completion(validated, key, controller.signal));
    } catch (error) {
      if (!res.writableEnded && !res.destroyed) return sendError(res, error);
    } finally {
      clearTimeout(timer); res.off?.('close', disconnect); req.off?.('aborted', disconnect);
    }
  }
  return { models, benchmark };
}
export const handlers = createHandlers();
