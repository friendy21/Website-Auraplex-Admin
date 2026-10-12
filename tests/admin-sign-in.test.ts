// Next.js request APIs (headers(), cookies(), redirect()) need its Node
// environment set up before any of its modules load, so this import is first.
import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import test from 'node:test';
import NextAuth from 'next-auth';
import { NextRequest } from 'next/server';

import { ADMIN_HOME_PATH, AUTH_PROVIDER_ID, adminSignInPath, safeCallbackPath } from '../lib/admin/admin-routes';
import { AUTHENTIK_SCOPES, authentikProvider, createAdminAuthConfig } from '../lib/admin/server/auth-config';
import { authSessionCookieName } from '../lib/admin/server/auth-cookies';
import { logIdTokenClaimShape } from '../lib/admin/server/authorization';
import { getAuthentikConfig, oidcDiscoveryUrl } from '../lib/admin/server/config';
import { createAdminSessionLoader, identityFromLoadedSession } from '../lib/admin/server/session';
import { createFakeAuthentik, type FakeAuthentik } from './helpers/fake-authentik';
import { ORIGIN, cookieHeader, deliverCallback, visitSignIn } from './helpers/sign-in-flow';

// The sign-in entry route and the Auth.js route are run for real, with the
// application's own Auth.js instance, against an in-process Authentik reached
// through a stubbed fetch. Nothing leaves the process.
const TEST_ENV = {
  AUTH_SECRET: 'test-only-auth-secret-0123456789abcdef',
  AUTH_URL: ORIGIN,
  // As Authentik publishes it: per provider, with a trailing slash.
  AUTHENTIK_ISSUER: 'https://sso.example.test/application/o/admin-upload/',
  AUTHENTIK_CLIENT_ID: 'admin-upload-test',
  AUTHENTIK_CLIENT_SECRET: 'test-only',
};
Object.assign(process.env, TEST_ENV);
const AUTHENTIK = {
  issuer: TEST_ENV.AUTHENTIK_ISSUER,
  clientId: TEST_ENV.AUTHENTIK_CLIENT_ID,
  clientSecret: TEST_ENV.AUTHENTIK_CLIENT_SECRET,
};
const CALLBACK_URI = `${ORIGIN}/api/auth/callback/authentik`;
const SESSION_COOKIE = authSessionCookieName(false);

/** The provider the stubbed fetch talks to; each test picks its own. */
let authentik: FakeAuthentik;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => authentik.fetcher(Date.now)(input, init)) as typeof fetch;

const logs: string[] = [];
console.info = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
console.error = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };

async function provider(options: { scopeMappings?: string[] } = {}) {
  authentik = await createFakeAuthentik({ ...AUTHENTIK, redirectUris: [CALLBACK_URI], ...options });
  return authentik;
}

/** A complete login: /sign-in → Authentik → the Auth.js callback route. */
async function login(sub: string, groups: string[], callbackUrl = ADMIN_HOME_PATH) {
  const start = await visitSignIn(`?${new URLSearchParams({ callbackUrl })}`);
  assert.ok(start.location, '/sign-in redirects');
  const backToApp = authentik.authorize(start.location, sub, groups);
  const callback = await deliverCallback(backToApp, cookieHeader(start.setCookies));
  return { start, callback, setCookies: callback.headers.getSetCookie() };
}

async function identityFor(setCookies: string[]) {
  const { auth } = await import('../auth');
  const loaded = await createAdminSessionLoader(auth)(new Headers({ host: 'admin.example.test', cookie: cookieHeader(setCookies) }));
  return identityFromLoadedSession(loaded);
}

// --- Configuration ----------------------------------------------------------

test('the Authentik issuer is kept exactly, trailing slash included', () => {
  assert.equal(getAuthentikConfig().issuer, TEST_ENV.AUTHENTIK_ISSUER);
  assert.equal(
    getAuthentikConfig({ ...TEST_ENV, NODE_ENV: 'test', AUTHENTIK_ISSUER: 'https://auth.auraplex.info/application/o/admin-upload-provider/' }).issuer,
    'https://auth.auraplex.info/application/o/admin-upload-provider/',
  );
  assert.throws(() => getAuthentikConfig({ ...TEST_ENV, NODE_ENV: 'test', AUTHENTIK_ISSUER: 'not a url' }), /AUTHENTIK_ISSUER must be a valid HTTP\(S\) URL/);
  // The most likely typo is refused by name instead of as a later issuer mismatch.
  assert.throws(
    () => getAuthentikConfig({ ...TEST_ENV, NODE_ENV: 'test', AUTHENTIK_ISSUER: 'https://auth.auraplex.info/application/o/admin-upload-provider' }),
    /AUTHENTIK_ISSUER must end with "\/"/,
  );
  // The old names are not read.
  assert.throws(
    () => getAuthentikConfig({ AUTH_SECRET: 'x', KEYCLOAK_ISSUER: 'https://x', KEYCLOAK_CLIENT_ID: 'x', KEYCLOAK_CLIENT_SECRET: 'x' } as never),
    /AUTHENTIK_ISSUER, AUTHENTIK_CLIENT_ID, AUTHENTIK_CLIENT_SECRET/,
  );
});

test('discovery is at the issuer plus /.well-known/openid-configuration, never a double slash', () => {
  assert.equal(
    oidcDiscoveryUrl('https://auth.auraplex.info/application/o/admin-upload-provider/'),
    'https://auth.auraplex.info/application/o/admin-upload-provider/.well-known/openid-configuration',
  );
  assert.equal(oidcDiscoveryUrl('https://sso.example.test/realm'), 'https://sso.example.test/realm/.well-known/openid-configuration');
});

test('the provider is the generic OIDC one: id authentik, discovery, Basic client auth, offline_access and profile', () => {
  const config = authentikProvider(getAuthentikConfig());
  assert.equal(config.id, AUTH_PROVIDER_ID);
  assert.equal(config.id, 'authentik', 'fixes the registered redirect URI /api/auth/callback/authentik');
  assert.equal(config.type, 'oidc');
  assert.equal(config.issuer, TEST_ENV.AUTHENTIK_ISSUER);
  assert.equal(config.client?.token_endpoint_auth_method, 'client_secret_basic');
  const scopes = String((config.authorization as { params: { scope: string } }).params.scope).split(' ');
  assert.deepEqual(scopes, AUTHENTIK_SCOPES.split(' '));
  for (const scope of ['openid', 'email', 'profile', 'offline_access']) assert.ok(scopes.includes(scope), scope);
  // No endpoint is hardcoded: they all come from discovery.
  for (const endpoint of ['token', 'userinfo', 'jwks_endpoint', 'wellKnown'] as const) {
    assert.equal((config as unknown as Record<string, unknown>)[endpoint], undefined, endpoint);
  }
});

test('only a same-origin path is accepted as the place to return to after sign-in', () => {
  assert.equal(safeCallbackPath('/admin/upload'), '/admin/upload');
  assert.equal(safeCallbackPath('/api/admin/csrf?x=1'), '/api/admin/csrf?x=1');
  assert.equal(safeCallbackPath('/signed-out'), '/signed-out');
  for (const unsafe of [
    null, '', 'admin/upload', 'https://evil.example.test/', '//evil.example.test/', '/\\evil.example.test',
    // Browsers strip tabs and newlines and may read a backslash as a slash.
    '/\t/evil.example.test', '/\n/evil.example.test', '/admin\\..\\..', '/admin/upload\u0000',
    // The sign-in machinery itself would start another sign-in: a loop.
    '/sign-in', '/sign-in?callbackUrl=%2Fsign-in', '/sign-in/', '/api/auth/signin/authentik', '/api/auth', '/api/auth#x',
  ]) {
    assert.equal(safeCallbackPath(unsafe), ADMIN_HOME_PATH, JSON.stringify(unsafe));
  }
  assert.equal(adminSignInPath('/admin/upload'), '/sign-in?callbackUrl=%2Fadmin%2Fupload');
});

// --- Why /sign-in exists ----------------------------------------------------

test('Auth.js v5 refuses a browser GET to /api/auth/signin/authentik (the staging UnknownAction)', async () => {
  await provider();
  const { handlers } = NextAuth(createAdminAuthConfig({ env: { ...TEST_ENV, NODE_ENV: 'test' } }));
  const before = logs.length;
  const response = await handlers.GET(new NextRequest(`${ORIGIN}/api/auth/signin/authentik?callbackUrl=/admin/upload`));
  assert.equal(response.status, 302);
  assert.equal(new URL(response.headers.get('location')!).pathname, '/api/auth/error');
  assert.ok(logs.slice(before).some((line) => /UnknownAction/.test(line)), 'Auth.js logs UnknownAction');
  assert.equal(authentik.calls.discovery, 0, 'Authentik is never reached');
});

// --- The sign-in round trip -------------------------------------------------

test('sign-in: /sign-in → Authentik authorize → callback/authentik → a session with the ID token\'s groups', async () => {
  await provider();
  const { start, callback, setCookies } = await login('ak-uploader-1', ['auraplex-uploader']);

  // /sign-in sent the browser to the discovered authorization endpoint.
  const authorize = new URL(start.location!);
  assert.equal(`${authorize.origin}${authorize.pathname}`, authentik.endpoints.authorization);
  assert.equal(authorize.searchParams.get('client_id'), TEST_ENV.AUTHENTIK_CLIENT_ID);
  assert.equal(authorize.searchParams.get('redirect_uri'), CALLBACK_URI);
  assert.equal(authorize.searchParams.get('response_type'), 'code');
  assert.equal(authorize.searchParams.get('scope'), AUTHENTIK_SCOPES);
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(start.setCookies.some((cookie) => cookie.startsWith('authjs.pkce.code_verifier=')), 'PKCE verifier cookie set');

  // The callback completed: no error page, back to the Admin home, session set.
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get('location'), `${ORIGIN}${ADMIN_HOME_PATH}`);
  assert.ok(setCookies.some((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`) && !/Max-Age=0/i.test(cookie)), 'session cookie set');
  assert.ok(setCookies.some((cookie) => cookie.startsWith('auraplex.browser-instance=')), 'login bound to the browser');
  assert.equal(authentik.calls.token, 1, 'one authorization-code exchange');

  const identity = await identityFor(setCookies);
  assert.deepEqual(identity, { userId: 'ak-uploader-1', email: 'ak-uploader-1@example.test', groups: ['auraplex-uploader'] });
});

test('sign-in: an admin\'s groups arrive intact; a user in neither group gets a session with no permission', async () => {
  await provider();
  const admin = await identityFor((await login('ak-admin-1', ['auraplex-admin', 'auraplex-uploader'])).setCookies);
  assert.deepEqual(admin?.groups, ['auraplex-admin', 'auraplex-uploader']);
  // Authentik's application binding should already stop this user; if it does
  // not, the session carries no Admin group and every Admin route answers 403.
  const outsider = await identityFor((await login('ak-outsider-1', ['staff'])).setCookies);
  assert.deepEqual(outsider?.groups, ['staff']);
});

test('sign-in: a return path on another origin is replaced by the Admin home', async () => {
  await provider();
  const { start, callback } = await login('ak-uploader-2', ['auraplex-uploader'], 'https://evil.example.test/steal');
  assert.ok(start.location);
  assert.equal(callback.headers.get('location'), `${ORIGIN}${ADMIN_HOME_PATH}`);
});

test('sign-in without the offline_access scope mapping is refused visibly, not looped', async () => {
  // The live provider's discovery (2026-10-12) lists only openid, email and
  // profile: Authentik then drops offline_access and issues no refresh token.
  await provider({ scopeMappings: ['openid', 'email', 'profile'] });
  const before = logs.length;
  const { callback, setCookies } = await login('ak-uploader-3', ['auraplex-uploader']);
  const location = new URL(callback.headers.get('location')!);
  assert.equal(location.pathname, '/api/auth/error');
  assert.equal(location.searchParams.get('error'), 'AccessDenied');
  assert.equal(setCookies.some((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`) && !/Max-Age=0/i.test(cookie)), false, 'no session');
  const rejected = logs.slice(before).map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .find((entry) => entry?.type === 'admin_sign_in');
  assert.deepEqual(rejected?.reason, 'no-refresh-token');
  assert.match(rejected?.hint, /offline_access/);
});

test('/sign-in answers 503 when Authentik is not configured, before contacting it', async () => {
  await provider();
  const secret = process.env.AUTHENTIK_CLIENT_SECRET;
  delete process.env.AUTHENTIK_CLIENT_SECRET;
  try {
    const { response, location } = await visitSignIn('?callbackUrl=/admin/upload');
    assert.equal(location, null);
    assert.equal(response?.status, 503);
    assert.equal(authentik.calls.discovery, 0);
  } finally {
    process.env.AUTHENTIK_CLIENT_SECRET = secret;
  }
});

// --- Claim-structure log (ADMIN_AUTH_DEBUG_CLAIMS) --------------------------

test('the claim-structure log shows names, iss, aud and groups, and only the type of everything else', () => {
  const before = logs.length;
  logIdTokenClaimShape('sign-in', {
    iss: TEST_ENV.AUTHENTIK_ISSUER, sub: 'a1b2c3', aud: 'admin-upload-test', exp: 1, iat: 1,
    email: 'person@example.test', name: 'Person', groups: ['auraplex-uploader'], amr: ['pwd'], nonce: null,
  });
  const entry = JSON.parse(logs[before]);
  assert.deepEqual(entry, {
    type: 'admin_id_token_claims',
    source: 'sign-in',
    claims: {
      amr: '<array(1)>', aud: 'admin-upload-test', email: '<string>', exp: '<number>', groups: ['auraplex-uploader'],
      iat: '<number>', iss: TEST_ENV.AUTHENTIK_ISSUER, name: '<string>', nonce: null, sub: '<string>',
    },
  });
  assert.doesNotMatch(logs[before], /a1b2c3|person@example\.test/);
});

test('the claim-structure log is off unless ADMIN_AUTH_DEBUG_CLAIMS=1', async () => {
  for (const [flag, expected] of [[undefined, 0], ['1', 1]] as const) {
    const config = createAdminAuthConfig({ env: { ...TEST_ENV, NODE_ENV: 'test', ADMIN_AUTH_DEBUG_CLAIMS: flag } });
    const before = logs.length;
    await config.callbacks!.signIn!({
      user: { id: 'u' },
      account: { provider: 'authentik', type: 'oidc', providerAccountId: 's', refresh_token: 'r' },
      profile: { sub: 's', groups: ['auraplex-admin'] },
    } as never);
    assert.equal(logs.slice(before).filter((line) => line.includes('admin_id_token_claims')).length, expected, String(flag));
  }
});
