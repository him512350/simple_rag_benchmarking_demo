import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuth } from '../lib/auth.js';

const env = () => ({ ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'test-password-only', ADMIN_SESSION_SECRET: 'test-session-secret-at-least-32-characters' });
const req = (body, extra = {}) => ({ method: 'POST', headers: { host: 'localhost:5173', origin: 'http://localhost:5173', 'content-type': 'application/json', ...extra }, body });
function response() { return { headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(v) { this.code = v; return this; }, json(v) { this.body = v; return this; } }; }
const credentials = { action: 'login', username: 'admin', password: 'test-password-only' };

test('login issues signed HttpOnly strict 8h cookie; session, forgery, expiry and credential rotation', async () => {
  let time = 100000000; const config = env(); const auth = createAuth(() => config, () => time); const res = response();
  await auth.handler(req(credentials), res); assert.equal(res.code, 200); const cookie = res.headers['Set-Cookie']; assert.match(cookie, /HttpOnly; SameSite=Strict; Max-Age=28800/); assert.ok(!cookie.includes('test-password-only')); assert.ok(!cookie.includes('; Secure'));
  const sessionRequest = { headers: { cookie: cookie.split(';')[0] } }; assert.deepEqual(auth.session(sessionRequest), { username: 'admin' });
  assert.equal(auth.session({ headers: { cookie: sessionRequest.headers.cookie + 'x' } }), null);
  assert.equal(auth.session({ headers: { cookie: sessionRequest.headers.cookie + '; ' + sessionRequest.headers.cookie } }), null);
  config.ADMIN_PASSWORD = 'changed'; assert.equal(auth.session(sessionRequest), null); config.ADMIN_PASSWORD = 'test-password-only';
  time += 8 * 60 * 60 * 1000; assert.equal(auth.session(sessionRequest), null);
});
test('cross-origin/missing origin, non-JSON and invalid credentials fail without session', async () => {
  const auth = createAuth(env);
  for (const [body, headers, code] of [[credentials, { origin: 'https://evil.test' }, 403], [credentials, { origin: undefined }, 403], [credentials, { 'content-type': 'text/plain' }, 415], [{ ...credentials, username: 'wrong' }, {}, 401], [{ ...credentials, password: 'wrong' }, {}, 401]]) {
    const res = response(); await auth.handler(req(body, headers), res); assert.equal(res.code, code); assert.equal(res.headers['Set-Cookie'], undefined);
  }
});
test('Vercel preview enforces HTTPS and Secure even with development NODE_ENV; logout clears cookie', async () => {
  const auth = createAuth(() => ({ ...env(), VERCEL: '1', NODE_ENV: 'development' })); const res = response();
  await auth.handler(req(credentials, { host: 'preview.vercel.app', origin: 'https://preview.vercel.app' }), res); assert.equal(res.code, 200); assert.match(res.headers['Set-Cookie'], /; Secure/);
  const logout = response(); await auth.handler(req({ action: 'logout' }, { host: 'preview.vercel.app', origin: 'https://preview.vercel.app' }), logout); assert.equal(logout.code, 200); assert.match(logout.headers['Set-Cookie'], /Max-Age=0/);
});
test('missing or short server config returns false session and clear login error', async () => {
  const auth = createAuth(() => ({ ...env(), ADMIN_SESSION_SECRET: 'short' })); const res = response(); await auth.handler(req(credentials), res); assert.equal(res.code, 503);
  const get = response(); await auth.handler({ method: 'GET', headers: {} }, get); assert.deepEqual(get.body, { authenticated: false }); assert.equal(get.headers['Cache-Control'], 'no-store');
});
