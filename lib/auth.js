import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { ApiError } from './openrouter.js';
import { utf8Bytes } from './limits.js';

const COOKIE = 'prompt_bench_admin';
const TTL_SECONDS = 8 * 60 * 60;
const hash = value => createHash('sha256').update(value).digest();
const equal = (left, right) => timingSafeEqual(hash(left), hash(right));
export function jsonBody(req, maxBytes = 256 * 1024) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers?.['content-type'] || '')) throw new ApiError(415, 'Use Content-Type: application/json.');
  if (Number(req.headers?.['content-length']) > maxBytes) throw new ApiError(413, 'Request is too large.');
  let body = req.body;
  if (typeof body === 'string') {
    if (utf8Bytes(body) > maxBytes) throw new ApiError(413, 'Request is too large.');
    try { body = JSON.parse(body); } catch { throw new ApiError(400, 'Invalid JSON body.'); }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'Send a JSON object.');
  if (utf8Bytes(JSON.stringify(body)) > maxBytes) throw new ApiError(413, 'Request is too large.');
  return body;
}
export function assertSameOrigin(req, production = Boolean(process.env.VERCEL) || process.env.NODE_ENV === 'production') {
  const expected = `${production ? 'https' : 'http'}://${req.headers?.host}`;
  if (!req.headers?.origin || req.headers.origin !== expected) throw new ApiError(403, 'This action must come from this website.');
}
export function apiFailure(res, error, fallback = 'The request could not be completed. Try again.') {
  return res.status(error instanceof ApiError ? error.status : 502).json({ error: error instanceof ApiError ? error.message : fallback });
}
export function createAuth(getEnv = () => process.env, now = () => Date.now()) {
  function config() {
    const env = getEnv();
    if (!env.ADMIN_USERNAME || !env.ADMIN_PASSWORD || !env.ADMIN_SESSION_SECRET || env.ADMIN_SESSION_SECRET.length < 32) throw new ApiError(503, 'Admin login is not configured. Set ADMIN_USERNAME, ADMIN_PASSWORD, and an ADMIN_SESSION_SECRET of at least 32 characters on the server.');
    return { username: env.ADMIN_USERNAME, password: env.ADMIN_PASSWORD, secret: env.ADMIN_SESSION_SECRET, production: Boolean(env.VERCEL) || env.NODE_ENV === 'production' };
  }
  const sign = (value, secret) => createHmac('sha256', secret).update(value).digest('base64url');
  const fingerprint = cfg => sign(JSON.stringify([cfg.username, cfg.password]), cfg.secret);
  function session(req) {
    try {
      const cfg = config();
      const cookies = (req.headers?.cookie || '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${COOKIE}=`));
      if (cookies.length !== 1 || cookies[0].length > 4096) return null;
      const token = cookies[0].slice(COOKIE.length + 1); const parts = token.split('.');
      if (parts.length !== 2 || !equal(parts[1], sign(parts[0], cfg.secret))) return null;
      const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
      if (payload.username !== cfg.username || !Number.isSafeInteger(payload.exp) || payload.exp <= now() || payload.exp > now() + TTL_SECONDS * 1000 || !equal(String(payload.fingerprint), fingerprint(cfg))) return null;
      return { username: cfg.username };
    } catch { return null; }
  }
  function requireAdmin(req) { if (!session(req)) throw new ApiError(401, 'Log in as admin to save shared defaults.'); }
  function mutation(req) { assertSameOrigin(req, Boolean(getEnv().VERCEL) || getEnv().NODE_ENV === 'production'); }
  function cookie(value, maxAge) { return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${Boolean(getEnv().VERCEL) || getEnv().NODE_ENV === 'production' ? '; Secure' : ''}`; }
  async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'GET') return res.status(200).json({ authenticated: Boolean(session(req)) });
    if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ error: 'Use GET or POST.' }); }
    try {
      mutation(req); const body = jsonBody(req, 8192);
      if (body.action === 'logout') { res.setHeader('Set-Cookie', cookie('', 0)); return res.status(200).json({ authenticated: false }); }
      if (body.action !== 'login') throw new ApiError(400, 'Choose login or logout.');
      const cfg = config();
      const username = typeof body.username === 'string' ? body.username : '';
      const password = typeof body.password === 'string' ? body.password : '';
      const usernameOK = equal(username, cfg.username); const passwordOK = equal(password, cfg.password);
      if (!usernameOK || !passwordOK) throw new ApiError(401, 'Invalid username or password.');
      const payload = Buffer.from(JSON.stringify({ username: cfg.username, exp: now() + TTL_SECONDS * 1000, fingerprint: fingerprint(cfg) })).toString('base64url');
      res.setHeader('Set-Cookie', cookie(`${payload}.${sign(payload, cfg.secret)}`, TTL_SECONDS));
      return res.status(200).json({ authenticated: true });
    } catch (error) { return apiFailure(res, error); }
  }
  return { handler, session, requireAdmin, mutation };
}
export const auth = createAuth();
