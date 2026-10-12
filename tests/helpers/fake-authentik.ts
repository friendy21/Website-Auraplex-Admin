import { createHash } from 'node:crypto';
import { SignJWT, exportJWK, generateKeyPair, type JWTPayload } from 'jose';

/**
 * In-process Authentik stand-in for session tests: OIDC discovery, JWKS, the
 * authorization-code leg of a login, and a refresh-token endpoint that rotates
 * the refresh token on every use. It is reached only through an injected (or
 * stubbed global) fetch; nothing here opens a socket.
 *
 * Its shapes follow Authentik 2026.2 as published by the live provider's
 * discovery document: the issuer is per provider and ends in a slash
 * (`<origin>/application/o/<slug>/`), the JWKS and end-session endpoints sit
 * under it, while the authorization and token endpoints are shared by all
 * providers (`<origin>/application/o/authorize/`, `.../token/`). ID tokens are
 * RS256, carry `groups` from the profile scope and no `azp`, and the token
 * response has no `refresh_expires_in`.
 */
export interface FakeAuthentikConfig {
  /** Must end in a slash, like every Authentik provider issuer. */
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Redirect URIs registered on the provider (strict match). */
  redirectUris?: string[];
  /**
   * Scope mappings attached to the provider. Authentik silently drops a
   * requested scope that has no mapping, and issues a refresh token only when
   * `offline_access` was granted.
   */
  scopeMappings?: string[];
}

export type FakeAuthentikMode =
  | 'ok' | 'timeout' | 'network' | 'http-5xx' | 'not-json' | 'no-id-token' | 'no-refresh-token' | 'same-refresh-token';

type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

async function signingKey(kid: string) {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  return { privateKey, jwk: { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' } };
}

// RSA key generation is slow, so every fake starts with the same key and
// forges with the same foreign key; rotateSigningKey() still makes a new one.
let initialKey: ReturnType<typeof signingKey> | undefined;
let foreignKey: Promise<SigningKey> | undefined;

/** The endpoints a fake provider with this issuer publishes. */
export function fakeAuthentikEndpoints(issuer: string) {
  if (!issuer.endsWith('/')) throw new Error('An Authentik issuer ends in a slash');
  const origin = new URL(issuer).origin;
  return {
    discovery: `${issuer}.well-known/openid-configuration`,
    authorization: `${origin}/application/o/authorize/`,
    token: `${origin}/application/o/token/`,
    userinfo: `${origin}/application/o/userinfo/`,
    jwks: `${issuer}jwks/`,
    endSession: `${issuer}end-session/`,
  };
}

/** Authentik's discovery document for a provider, trimmed to what OIDC clients read. */
export function fakeAuthentikDiscovery(issuer: string, scopes: Iterable<string> = ['openid', 'email', 'profile', 'offline_access']) {
  const endpoints = fakeAuthentikEndpoints(issuer);
  return {
    issuer,
    authorization_endpoint: endpoints.authorization,
    token_endpoint: endpoints.token,
    userinfo_endpoint: endpoints.userinfo,
    end_session_endpoint: endpoints.endSession,
    jwks_uri: endpoints.jwks,
    response_types_supported: ['code'],
    id_token_signing_alg_values_supported: ['RS256'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
    scopes_supported: [...scopes],
    claims_supported: ['sub', 'iss', 'aud', 'exp', 'iat', 'auth_time', 'email', 'email_verified', 'name', 'preferred_username', 'groups'],
    code_challenge_methods_supported: ['plain', 'S256'],
  };
}

const ALL_SCOPES = ['openid', 'email', 'profile', 'offline_access'];

export async function createFakeAuthentik(config: FakeAuthentikConfig) {
  const endpoints = fakeAuthentikEndpoints(config.issuer);
  const scopeMappings = new Set(config.scopeMappings ?? ALL_SCOPES);
  let key = await (initialKey ??= signingKey('test-key-1'));
  const users = new Map<string, { groups: string[]; enabled: boolean }>();
  /** Live refresh tokens and the scopes granted with them. A redeemed token is removed, as with rotation. */
  const grants = new Map<string, { sub: string; scopes: Set<string> }>();
  /** Unredeemed authorization codes. */
  const codes = new Map<string, { sub: string; scopes: Set<string>; redirectUri: string; codeChallenge: string; nonce: string | null }>();
  let serial = 0;

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const invalidGrant = () => json({
    error: 'invalid_grant',
    error_description: 'The provided authorization grant or refresh token is invalid, expired, revoked, does not '
      + 'match the redirection URI used in the authorization request, or was issued to another client',
  }, 400);

  function newRefreshToken(sub: string, scopes: Set<string>): string {
    const refreshToken = `refresh-${sub}-${++serial}`;
    grants.set(refreshToken, { sub, scopes });
    return refreshToken;
  }

  /** ID-token claims as Authentik's default scope mappings produce them. */
  function idTokenClaims(sub: string, scopes: Set<string>, nowSeconds: number, nonce: string | null): JWTPayload {
    const user = users.get(sub)!;
    return {
      iss: config.issuer,
      sub,
      aud: config.clientId,
      exp: nowSeconds + 300,
      iat: nowSeconds,
      auth_time: nowSeconds - 60,
      acr: 'goauthentik.io/providers/oauth2/default',
      ...(nonce ? { nonce } : {}),
      ...(scopes.has('email') ? { email: `${sub}@example.test`, email_verified: true } : {}),
      ...(scopes.has('profile')
        ? { name: 'Test User', given_name: 'Test User', preferred_username: sub, nickname: sub, groups: [...user.groups] }
        : {}),
    };
  }

  async function signIdToken(claims: JWTPayload): Promise<string> {
    // Same kid as the published key, but a private key that is not in the JWKS.
    const signer: SigningKey = fake.forgeSignature
      ? await (foreignKey ??= signingKey('foreign').then(({ privateKey }) => privateKey))
      : key.privateKey;
    return new SignJWT(fake.tamper ? fake.tamper(claims) : claims)
      .setProtectedHeader({ alg: 'RS256', kid: key.jwk.kid, typ: 'JWT' })
      .sign(signer);
  }

  const fake = {
    mode: 'ok' as FakeAuthentikMode,
    endpoints,
    calls: { discovery: 0, jwks: 0, token: 0 },
    /** Refresh tokens presented to the token endpoint, in order. */
    presented: [] as string[],
    /** Runs while the token request is "on the network". */
    duringTokenRequest: null as null | (() => void | Promise<void>),
    /** Alters the ID-token claims before signing. */
    tamper: null as null | ((claims: JWTPayload) => JWTPayload),
    /** Signs the ID token with a key that is not in the JWKS. */
    forgeSignature: false,
    /** Alters the discovery document before it is served. */
    tamperDiscovery: null as null | ((discovery: Record<string, unknown>) => Record<string, unknown>),

    /** Registers (or updates) a user and returns a live refresh token with every scope. */
    grant(sub: string, groups: string[]): string {
      users.set(sub, { groups, enabled: true });
      return newRefreshToken(sub, new Set(ALL_SCOPES));
    },
    /** Group membership changed in Authentik; the next ID token carries it. */
    setGroups(sub: string, groups: string[]) {
      users.get(sub)!.groups = groups;
    },
    /** The user is deactivated in Authentik. */
    disable(sub: string) {
      users.get(sub)!.enabled = false;
    },
    /** Ends one Authentik session: its refresh token is no longer accepted. */
    revoke(refreshToken: string) {
      grants.delete(refreshToken);
    },
    async rotateSigningKey() {
      key = await signingKey(`test-key-${++serial}`);
    },

    /**
     * The browser at Authentik's authorization endpoint, with `sub` already
     * authenticated and allowed by the application's bindings. Returns the
     * redirect back to the application, as Authentik would issue it.
     */
    authorize(authorizationUrl: string, sub: string, groups: string[]): string {
      const url = new URL(authorizationUrl);
      const params = url.searchParams;
      if (`${url.origin}${url.pathname}` !== endpoints.authorization) throw new Error(`Not the authorization endpoint: ${url}`);
      if (params.get('client_id') !== config.clientId) throw new Error('Unknown client_id');
      const redirectUri = params.get('redirect_uri') ?? '';
      // Authentik refuses an unregistered redirect URI on its own error page.
      if (!(config.redirectUris ?? []).includes(redirectUri)) throw new Error(`Redirect URI not registered: ${redirectUri}`);
      if (params.get('response_type') !== 'code') throw new Error('Unsupported response_type');
      if (params.get('code_challenge_method') !== 'S256' || !params.get('code_challenge')) throw new Error('PKCE S256 expected');
      const scopes = new Set((params.get('scope') ?? '').split(' ').filter((scope) => scopeMappings.has(scope)));
      if (!scopes.has('openid')) throw new Error('openid scope missing');
      users.set(sub, { groups, enabled: true });
      const code = `code-${++serial}`;
      codes.set(code, { sub, scopes, redirectUri, codeChallenge: params.get('code_challenge')!, nonce: params.get('nonce') });
      const back = new URL(redirectUri);
      back.searchParams.set('code', code);
      const state = params.get('state');
      if (state) back.searchParams.set('state', state);
      return back.toString();
    },

    fetcher(now: () => number): typeof fetch {
      return async (input, init) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url === endpoints.discovery) {
          fake.calls.discovery += 1;
          const discovery = fakeAuthentikDiscovery(config.issuer, scopeMappings);
          return json(fake.tamperDiscovery ? fake.tamperDiscovery(discovery) : discovery);
        }
        if (url === endpoints.jwks) {
          fake.calls.jwks += 1;
          return json({ keys: [key.jwk] });
        }
        if (url !== endpoints.token) throw new Error(`Unexpected request: ${url}`);

        fake.calls.token += 1;
        const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
        const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
        const expected = `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`;
        if (method !== 'POST' || headers.get('authorization') !== expected) {
          return json({ error: 'invalid_client', error_description: 'Client authentication failed' }, 401);
        }
        const form = new URLSearchParams(init?.body !== undefined ? String(init.body) : await (input as Request).text());
        const nowSeconds = Math.floor(now() / 1000);

        if (form.get('grant_type') === 'authorization_code') {
          const issued = codes.get(form.get('code') ?? '');
          codes.delete(form.get('code') ?? '');
          const verifier = form.get('code_verifier') ?? '';
          if (!issued || issued.redirectUri !== form.get('redirect_uri')
            || createHash('sha256').update(verifier).digest('base64url') !== issued.codeChallenge) {
            return invalidGrant();
          }
          const idToken = await signIdToken(idTokenClaims(issued.sub, issued.scopes, nowSeconds, issued.nonce));
          return json({
            access_token: `access-${++serial}`,
            token_type: 'Bearer',
            scope: [...issued.scopes].join(' '),
            expires_in: 300,
            id_token: idToken,
            ...(issued.scopes.has('offline_access') ? { refresh_token: newRefreshToken(issued.sub, issued.scopes) } : {}),
          });
        }

        const presented = form.get('refresh_token') ?? '';
        fake.presented.push(presented);

        if (fake.mode === 'network') throw new TypeError('fetch failed');
        if (fake.mode === 'timeout') throw new DOMException('The operation timed out', 'TimeoutError');
        if (fake.mode === 'http-5xx') return json({ error: 'server_error' }, 503);

        const grant = grants.get(presented);
        const user = grant ? users.get(grant.sub) : undefined;
        if (form.get('grant_type') !== 'refresh_token' || !grant || !user?.enabled) return invalidGrant();
        // Rotation: the presented token is revoked and a new one issued with
        // the same scopes (no `scope` in the request means the original ones).
        grants.delete(presented);
        const refreshToken = newRefreshToken(grant.sub, grant.scopes);

        await fake.duringTokenRequest?.();
        if (fake.mode === 'not-json') return new Response('<html>gateway</html>', { status: 200 });

        const idToken = await signIdToken(idTokenClaims(grant.sub, grant.scopes, nowSeconds, null));
        return json({
          access_token: `access-${serial}`,
          token_type: 'Bearer',
          scope: [...grant.scopes].join(' '),
          expires_in: 300,
          ...(fake.mode === 'no-refresh-token' ? {} : { refresh_token: fake.mode === 'same-refresh-token' ? presented : refreshToken }),
          ...(fake.mode === 'no-id-token' ? {} : { id_token: idToken }),
        });
      };
    },
  };
  return fake;
}

export type FakeAuthentik = Awaited<ReturnType<typeof createFakeAuthentik>>;
