// Next.js request APIs (headers(), cookies(), redirect()) need its Node
// environment set up before any of its modules load, so this import is first.
import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import NextAuth from 'next-auth';
import { decode } from 'next-auth/jwt';
import { NextRequest } from 'next/server';

import { ADMIN_HOME_PATH } from '../lib/admin/admin-routes';
import { createAdminAuthConfig } from '../lib/admin/server/auth-config';
import {
  GATEWAY_RESPONSE_HEADER_LIMIT_BYTES,
  SESSION_COOKIE_BUDGET_BYTES,
  authSessionCookieName,
} from '../lib/admin/server/auth-cookies';
import {
  CALLBACK_HEADER_WARNING_BYTES,
  CallbackReplay,
  responseHeaderBytes,
} from '../lib/admin/server/oidc-callback';
import { createAdminSessionLoader, identityFromLoadedSession } from '../lib/admin/server/session';
import { createAdminProxy } from '../proxy';
import { createFakeAuthentik, type FakeAuthentik } from './helpers/fake-authentik';
import { ORIGIN, cookieHeader, deliverCallback, visitSignIn } from './helpers/sign-in-flow';

// AURA-INT-002 follow-up: the OIDC callback and its code exchange, through the
// application's own routes and Auth.js instance, against an in-process
// Authentik that redeems each authorization code once and checks PKCE.
const TEST_ENV = {
  AUTH_SECRET: 'test-only-auth-secret-0123456789abcdef',
  AUTH_URL: ORIGIN,
  AUTHENTIK_ISSUER: 'https://sso.example.test/application/o/admin-upload/',
  AUTHENTIK_CLIENT_ID: 'admin-upload-test',
  AUTHENTIK_CLIENT_SECRET: 'test-only',
};
Object.assign(process.env, TEST_ENV);
const AUTHENTIK = { issuer: TEST_ENV.AUTHENTIK_ISSUER, clientId: TEST_ENV.AUTHENTIK_CLIENT_ID, clientSecret: TEST_ENV.AUTHENTIK_CLIENT_SECRET };
const SESSION_COOKIE = authSessionCookieName(false);

let authentik: FakeAuthentik;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => authentik.fetcher(Date.now)(input, init)) as typeof fetch;

const logs: string[] = [];
console.info = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
console.warn = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
console.error = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
const entries = (type: string, since = 0) => logs.slice(since)
  .map((line) => { try { return JSON.parse(line) as Record<string, unknown>; } catch { return null; } })
  .filter((entry): entry is Record<string, unknown> => entry?.type === type);

async function provider() {
  authentik = await createFakeAuthentik({ ...AUTHENTIK, redirectUris: [`${ORIGIN}/api/auth/callback/authentik`] });
  return authentik;
}

/** Authentik's default subject mode: a SHA-256 of the user. */
const subject = (user: string) => createHash('sha256').update(user).digest('hex');

/** A browser that has been to /sign-in and to Authentik, about to deliver the callback. */
async function authorized(user: string, groups: string[]) {
  const start = await visitSignIn('?callbackUrl=%2Fadmin%2Fupload');
  assert.ok(start.location);
  return { callbackUrl: authentik.authorize(start.location, subject(user), groups), cookie: cookieHeader(start.setCookies) };
}

const sessionSet = (response: Response) =>
  response.headers.getSetCookie().find((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`) && !/Max-Age=0/i.test(cookie));

async function identityFor(response: Response) {
  const { auth } = await import('../auth');
  const loaded = await createAdminSessionLoader(auth)(new Headers({ host: 'admin.example.test', cookie: cookieHeader(response.headers.getSetCookie()) }));
  return identityFromLoadedSession(loaded);
}

// --- The failure, as Auth.js produces it on its own ---------------------------

test('without protection, a second delivery of a redeemed code fails with invalid_grant (the reported error)', async () => {
  await provider();
  const { callbackUrl, cookie } = await authorized('auraplex_server', ['auraplex-uploader']);
  // Auth.js's own handler, with nothing in front of it.
  const { handlers } = NextAuth(createAdminAuthConfig({ env: { ...TEST_ENV, NODE_ENV: 'test' } }));
  const deliver = () => handlers.GET(new NextRequest(callbackUrl, { headers: { host: 'admin.example.test', cookie } }));

  const first = await deliver();
  assert.equal(first.headers.get('location'), `${ORIGIN}${ADMIN_HOME_PATH}`);
  assert.ok(sessionSet(first));
  const before = logs.length;
  const second = await deliver();
  assert.equal(new URL(second.headers.get('location')!).searchParams.get('error'), 'Configuration');
  const logged = logs.slice(before).join('\n');
  assert.match(logged, /CallbackRouteError/);
  assert.match(logged, /server responded with an error in the response body/);
  assert.match(logged, /invalid_grant/);
  assert.equal(authentik.calls.token, 2, 'the spent code was presented to Authentik again');
});

// --- The fix: one redemption per code ----------------------------------------

test('a callback delivered again by the same browser gets the same session; the code is redeemed once', async () => {
  await provider();
  const { callbackUrl, cookie } = await authorized('auraplex_server', ['auraplex-uploader', 'auraplex-admin']);

  const first = await deliverCallback(callbackUrl, cookie);
  // Its response is lost on the way (e.g. refused by the ingress); the browser reloads.
  const again = await deliverCallback(callbackUrl, cookie);

  for (const response of [first, again]) {
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), `${ORIGIN}${ADMIN_HOME_PATH}`);
  }
  assert.equal(authentik.calls.token, 1, 'one authorization-code exchange');
  assert.equal(sessionSet(again), sessionSet(first), 'the same session cookie');
  assert.deepEqual(await identityFor(again), {
    userId: subject('auraplex_server'),
    email: `${subject('auraplex_server')}@example.test`,
    groups: ['auraplex-uploader', 'auraplex-admin'],
  });
});

test('simultaneous deliveries share one code exchange', async () => {
  await provider();
  const { callbackUrl, cookie } = await authorized('auraplex_server', ['auraplex-uploader']);
  const responses = await Promise.all([deliverCallback(callbackUrl, cookie), deliverCallback(callbackUrl, cookie), deliverCallback(callbackUrl, cookie)]);
  assert.equal(authentik.calls.token, 1);
  for (const response of responses) assert.equal(response.headers.get('location'), `${ORIGIN}${ADMIN_HOME_PATH}`);
  assert.equal(new Set(responses.map(sessionSet)).size, 1);
});

test('the callback URL alone, from a browser without that PKCE cookie, obtains no session', async () => {
  await provider();
  const victim = await authorized('auraplex_server', ['auraplex-admin']);
  assert.ok(sessionSet(await deliverCallback(victim.callbackUrl, victim.cookie)));

  // Another browser: no cookies at all, then its own (different) sign-in cookies.
  const stranger = await visitSignIn('?callbackUrl=%2Fadmin%2Fupload');
  for (const cookie of ['', cookieHeader(stranger.setCookies)]) {
    const response = await deliverCallback(victim.callbackUrl, cookie);
    assert.equal(sessionSet(response), undefined, `cookie: ${cookie ? 'other sign-in' : 'none'}`);
    assert.equal(new URL(response.headers.get('location')!).pathname, '/api/auth/error');
  }
});

test('a failed exchange is not kept: the same callback succeeds once Authentik answers again', async () => {
  await provider();
  const { callbackUrl, cookie } = await authorized('auraplex_server', ['auraplex-uploader']);
  authentik.mode = 'http-5xx';
  const failed = await deliverCallback(callbackUrl, cookie);
  assert.equal(sessionSet(failed), undefined);
  authentik.mode = 'ok';
  const retried = await deliverCallback(callbackUrl, cookie);
  assert.equal(retried.headers.get('location'), `${ORIGIN}${ADMIN_HOME_PATH}`);
  assert.ok(sessionSet(retried));
  assert.equal(authentik.calls.token, 2);
});

test('the replay keeps successes only for a while and holds a bounded number', async () => {
  let nowMs = 0;
  const replay = new CallbackReplay(1_000, 2);
  let handled = 0;
  const ok = () => { handled += 1; return Promise.resolve(new Response(null, { status: 302, headers: { 'set-cookie': `s=${handled}` } })); };
  const run = (key: string) => replay.run(key, () => nowMs, () => true, ok);
  assert.equal((await run('a')).delivery, 'first');
  assert.equal((await run('a')).delivery, 'replayed');
  nowMs = 1_000;
  assert.equal((await run('a')).delivery, 'first', 'expired');
  await run('b');
  await run('c');
  assert.ok(replay.size.settled <= 2);
  assert.equal(replay.size.inFlight, 0);
  assert.equal(handled, 4);
});

// --- Size: every response must fit the ingress -------------------------------

test('the callback and the first Admin page fit the ingress header limit, even for a user in many groups', async () => {
  await provider();
  const groups = ['auraplex-uploader', 'auraplex-admin', 'authentik Admins', ...Array.from({ length: 12 }, (_, i) => `department-group-${i}`)];
  const { callbackUrl, cookie } = await authorized('auraplex_server', groups);
  const callback = await deliverCallback(callbackUrl, cookie);
  const session = sessionSet(callback)!;
  assert.ok(session);

  assert.ok(Buffer.byteLength(session) < SESSION_COOKIE_BUDGET_BYTES, `session Set-Cookie is ${Buffer.byteLength(session)} bytes`);
  const callbackBytes = responseHeaderBytes(callback);
  assert.ok(callbackBytes < CALLBACK_HEADER_WARNING_BYTES, `callback headers are ${callbackBytes} bytes`);
  assert.ok(callbackBytes < GATEWAY_RESPONSE_HEADER_LIMIT_BYTES);

  // The session keeps neither the ID token nor the access token.
  const token = await decode({ token: session.split(';', 1)[0].slice(SESSION_COOKIE.length + 1), secret: TEST_ENV.AUTH_SECRET, salt: SESSION_COOKIE });
  assert.equal(token?.idToken, undefined);
  assert.equal(JSON.stringify(token).includes('access-'), false);

  // The first Admin page: Proxy re-issues the session cookie on it.
  const page = await createAdminProxy()(new NextRequest(`${ORIGIN}/admin/upload`, {
    headers: { host: 'admin.example.test', cookie: cookieHeader(callback.headers.getSetCookie()) },
  }));
  assert.equal(page.headers.get('x-middleware-next'), '1', 'the signed-in user reaches the page');
  const reissued = page.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`))!;
  assert.ok(Buffer.byteLength(reissued) < SESSION_COOKIE_BUDGET_BYTES, `re-issued cookie is ${Buffer.byteLength(reissued)} bytes`);
});

// --- Instrumentation ---------------------------------------------------------

test('each delivery is logged with a code digest, its delivery kind and the PKCE challenge; nothing secret', async () => {
  await provider();
  const since = logs.length;
  const start = await visitSignIn('?callbackUrl=%2Fadmin%2Fupload', { 'cf-ray': 'ray-1' });
  const callbackUrl = authentik.authorize(start.location!, subject('auraplex_server'), ['auraplex-uploader']);
  const cookie = cookieHeader(start.setCookies);
  await deliverCallback(callbackUrl, cookie, { 'cf-ray': 'ray-2' });
  await deliverCallback(callbackUrl, cookie, { 'cf-ray': 'ray-3' });

  const [signIn] = entries('admin_auth_sign_in', since);
  const callbacks = entries('admin_auth_callback', since);
  assert.equal(signIn.cfRay, 'ray-1');
  assert.equal(callbacks.length, 2);
  assert.deepEqual(callbacks.map((entry) => entry.delivery), ['first', 'replayed']);
  assert.deepEqual(callbacks.map((entry) => entry.cfRay), ['ray-2', 'ray-3']);
  assert.equal(callbacks[0].code, callbacks[1].code, 'the same code, recognisable across deliveries');
  // The verifier the browser presented belongs to the challenge /sign-in sent.
  assert.equal(typeof signIn.challenge, 'string');
  assert.equal(callbacks[0].verifierChallenge, signIn.challenge);
  assert.equal(callbacks[0].pkceCookies, 1);
  assert.equal(callbacks[0].outcome, 'session');
  assert.ok((callbacks[0].headerBytes as number) > 0);

  const code = new URL(callbackUrl).searchParams.get('code')!;
  const lines = logs.slice(since).join('\n');
  assert.equal(lines.includes(code), false, 'the code itself is never logged');
  assert.equal(lines.includes(cookie.split('=')[1]), false, 'the PKCE cookie is never logged');
});

test('a mismatched or doubled PKCE cookie shows in the callback log', async () => {
  await provider();
  const first = await visitSignIn('?callbackUrl=%2Fadmin%2Fupload');
  const second = await visitSignIn('?callbackUrl=%2Fadmin%2Fupload');
  // Authentik received the first challenge; the browser holds the second sign-in's cookie first.
  const callbackUrl = authentik.authorize(first.location!, subject('auraplex_server'), ['auraplex-uploader']);
  const since = logs.length;
  const response = await deliverCallback(callbackUrl, `${cookieHeader(second.setCookies)}; ${cookieHeader(first.setCookies)}`);
  assert.equal(sessionSet(response), undefined);
  const [entry] = entries('admin_auth_callback', since);
  assert.equal(entry.pkceCookies, 2);
  assert.notEqual(entry.verifierChallenge, new URL(first.location!).searchParams.get('code_challenge')!.slice(0, 12));
  assert.match(String(entry.outcome), /^error:/);
});

test('AUTH_DEBUG turns on Auth.js debug logging; it is off otherwise', () => {
  assert.equal(createAdminAuthConfig({ env: { ...TEST_ENV, NODE_ENV: 'test' } }).debug, false);
  assert.equal(createAdminAuthConfig({ env: { ...TEST_ENV, NODE_ENV: 'test', AUTH_DEBUG: 'true' } }).debug, true);
});
