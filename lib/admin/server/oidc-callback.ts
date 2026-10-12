/**
 * The OIDC callback, `/api/auth/callback/authentik` (AURA-INT-002 follow-up).
 *
 * An authorization code can be redeemed once. When the response of a callback
 * that succeeded never reaches the browser (refused or lost on the way, e.g.
 * by an ingress header limit) and the same callback is sent again (a reload,
 * a re-delivery), Auth.js would redeem the spent code a second time; Authentik
 * answers `invalid_grant`, which Auth.js reports as a Configuration error.
 * Here, a callback carrying the same code and the same PKCE verifier cookie as
 * one that is in flight, or that succeeded shortly before, gets that first
 * response again instead of a second redemption. Requiring the browser's own
 * PKCE cookie (HttpOnly) means a leaked callback URL alone obtains nothing.
 * Failures are never kept: a retry after one is handled afresh.
 *
 * Every callback is logged (`admin_auth_callback`): a digest of the code,
 * which delivery it was, the challenge of the PKCE verifier the browser
 * presented (comparable with the `challenge` /sign-in logged and the one
 * Authentik recorded), the outcome and the size of the response headers. No
 * code, verifier or token is logged.
 */
import { createHash } from 'node:crypto';
import { decode } from 'next-auth/jwt';
import { AUTH_PROVIDER_ID } from '@/lib/admin/admin-routes';
import {
  GATEWAY_RESPONSE_HEADER_LIMIT_BYTES,
  authCookieConfig,
  authSessionCookieName,
} from '@/lib/admin/server/auth-cookies';

export const OIDC_CALLBACK_PATH = `/api/auth/callback/${AUTH_PROVIDER_ID}`;
/** How long a successful callback stays replayable for the browser that sent it. */
export const CALLBACK_REPLAY_MS = 5 * 60_000;
export const CALLBACK_REPLAY_CAPACITY = 256;
/** A callback response with larger headers is logged as a warning. */
export const CALLBACK_HEADER_WARNING_BYTES = Math.floor(GATEWAY_RESPONSE_HEADER_LIMIT_BYTES * 0.75);
/** Length of the digests and challenge prefixes in the logs: enough to correlate, too short to reuse. */
const LOG_PREFIX_LENGTH = 12;

export type CallbackDelivery = 'first' | 'concurrent' | 'replayed' | 'unkeyed';

interface StoredResponse {
  status: number;
  headers: Array<[string, string]>;
  setCookies: string[];
  body: ArrayBuffer;
}

async function storeResponse(response: Response): Promise<StoredResponse> {
  return {
    status: response.status,
    headers: [...response.headers].filter(([name]) => name.toLowerCase() !== 'set-cookie'),
    setCookies: response.headers.getSetCookie(),
    body: await response.arrayBuffer(),
  };
}

function restoreResponse(stored: StoredResponse): Response {
  const headers = new Headers(stored.headers);
  for (const cookie of stored.setCookies) headers.append('set-cookie', cookie);
  const empty = stored.body.byteLength === 0 || stored.status === 204 || stored.status === 304;
  return new Response(empty ? null : stored.body.slice(0), { status: stored.status, headers });
}

/**
 * Process-local single flight per (code, PKCE cookie). Capped like the
 * refresh coordinator; past the cap a callback is simply handled, as without
 * this protection. Assumes a single Node.js instance, as the rest of the
 * session coordination does.
 */
export class CallbackReplay {
  private readonly inFlight = new Map<string, Promise<StoredResponse>>();
  private readonly settled = new Map<string, { response: StoredResponse; expiresAt: number }>();

  constructor(
    private readonly ttlMs = CALLBACK_REPLAY_MS,
    private readonly capacity = CALLBACK_REPLAY_CAPACITY,
  ) {}

  async run(
    key: string,
    now: () => number,
    succeeded: (response: Response) => boolean,
    handle: () => Promise<Response>,
  ): Promise<{ response: Response; delivery: CallbackDelivery }> {
    const settled = this.settled.get(key);
    if (settled) {
      if (now() < settled.expiresAt) return { response: restoreResponse(settled.response), delivery: 'replayed' };
      this.settled.delete(key);
    }
    const pending = this.inFlight.get(key);
    if (pending) return { response: restoreResponse(await pending), delivery: 'concurrent' };
    if (this.inFlight.size >= this.capacity) return { response: await handle(), delivery: 'unkeyed' };

    const started = handle().then(storeResponse);
    this.inFlight.set(key, started);
    try {
      const stored = await started;
      const response = restoreResponse(stored);
      if (succeeded(response)) this.remember(key, stored, now());
      return { response, delivery: 'first' };
    } finally {
      this.inFlight.delete(key);
    }
  }

  private remember(key: string, response: StoredResponse, nowMs: number): void {
    for (const [existing, entry] of this.settled) {
      if (nowMs >= entry.expiresAt) this.settled.delete(existing);
    }
    while (this.settled.size >= this.capacity) this.settled.delete(this.settled.keys().next().value as string);
    this.settled.set(key, { response, expiresAt: nowMs + this.ttlMs });
  }

  /** Entries currently held, for tests and diagnostics. */
  get size(): { inFlight: number; settled: number } {
    return { inFlight: this.inFlight.size, settled: this.settled.size };
  }
}

const SHARED_CALLBACK_REPLAY = Symbol.for('auraplex.admin.oidcCallbackReplay');

export function sharedCallbackReplay(): CallbackReplay {
  const holder = globalThis as { [SHARED_CALLBACK_REPLAY]?: CallbackReplay };
  return (holder[SHARED_CALLBACK_REPLAY] ??= new CallbackReplay());
}

function sha256(...parts: string[]): string {
  const hash = createHash('sha256');
  parts.forEach((part, index) => { if (index > 0) hash.update('\0'); hash.update(part); });
  return hash.digest('base64url');
}

/** Every value of one cookie in a Cookie header, in the order sent (Auth.js uses the first). */
function cookieValues(headers: Headers, name: string): string[] {
  const values: string[] = [];
  for (const pair of (headers.get('cookie') ?? '').split(';')) {
    const separator = pair.indexOf('=');
    if (separator > 0 && pair.slice(0, separator).trim() === name) values.push(pair.slice(separator + 1).trim());
  }
  return values;
}

/** Approximate size of a response's header block as it leaves the server (status line and every header line). */
export function responseHeaderBytes(response: Response): number {
  let bytes = `HTTP/1.1 ${response.status} \r\n`.length + 2;
  for (const [name, value] of response.headers) {
    if (name.toLowerCase() === 'set-cookie') continue;
    bytes += Buffer.byteLength(`${name}: ${value}\r\n`);
  }
  for (const cookie of response.headers.getSetCookie()) bytes += Buffer.byteLength(`set-cookie: ${cookie}\r\n`);
  return bytes;
}

/** The S256 challenge of the PKCE verifier in the cookie, shortened; null when there is none or it cannot be read. */
async function verifierChallenge(cookie: string | undefined, cookieName: string, secret: string | undefined): Promise<string | null> {
  if (!cookie || !secret) return null;
  const payload = await decode({ token: cookie, secret, salt: cookieName }).catch(() => null);
  const verifier = typeof payload?.value === 'string' ? payload.value : null;
  return verifier ? sha256(verifier).slice(0, LOG_PREFIX_LENGTH) : 'unreadable';
}

function callbackOutcome(response: Response, sessionCookie: string): string {
  const location = response.headers.get('location');
  if (location) {
    const target = new URL(location, 'http://local.invalid');
    if (target.pathname.endsWith('/api/auth/error')) return `error:${target.searchParams.get('error') ?? 'unknown'}`;
  }
  return startsSession(response, sessionCookie) ? 'session' : `status:${response.status}`;
}

function startsSession(response: Response, sessionCookie: string): boolean {
  return response.headers.getSetCookie().some((cookie) => {
    const name = /^[^=]+/.exec(cookie)?.[0] ?? '';
    return (name === sessionCookie || name.startsWith(`${sessionCookie}.`)) && !/max-age=0/i.test(cookie);
  });
}

function requestContext(headers: Headers) {
  return {
    cfRay: headers.get('cf-ray'),
    requestId: headers.get('x-request-id'),
    purpose: headers.get('sec-purpose') ?? headers.get('purpose'),
  };
}

export interface OidcCallbackOptions {
  replay?: CallbackReplay;
  production?: boolean;
  secret?: string;
  now?: () => number;
}

/** Wraps the Auth.js GET route; anything other than the OIDC callback passes straight through. */
export async function withOidcCallback(
  request: Request,
  handle: () => Promise<Response>,
  {
    replay = sharedCallbackReplay(),
    production = process.env.NODE_ENV === 'production',
    secret = process.env.AUTH_SECRET,
    now = Date.now,
  }: OidcCallbackOptions = {},
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== OIDC_CALLBACK_PATH) return handle();

  const startedAt = now();
  const code = url.searchParams.get('code');
  const pkceCookieName = authCookieConfig(production).pkceCodeVerifier.name;
  const pkceCookies = cookieValues(request.headers, pkceCookieName);
  const sessionCookie = authSessionCookieName(production);
  const key = code && pkceCookies[0] ? sha256(code, pkceCookies[0]) : null;
  const { response, delivery } = key
    ? await replay.run(key, now, (result) => startsSession(result, sessionCookie), handle)
    : { response: await handle(), delivery: 'unkeyed' as const };

  const headerBytes = responseHeaderBytes(response);
  const entry = {
    type: 'admin_auth_callback',
    code: code ? sha256(code).slice(0, LOG_PREFIX_LENGTH) : null,
    delivery,
    pkceCookies: pkceCookies.length,
    verifierChallenge: await verifierChallenge(pkceCookies[0], pkceCookieName, secret),
    status: response.status,
    outcome: callbackOutcome(response, sessionCookie),
    headerBytes,
    ms: now() - startedAt,
    ...requestContext(request.headers),
    ...(headerBytes > CALLBACK_HEADER_WARNING_BYTES
      ? { warning: `response headers are ${headerBytes} bytes; the ingress refuses more than about ${GATEWAY_RESPONSE_HEADER_LIMIT_BYTES}` }
      : {}),
  };
  (entry.warning ? console.warn : console.info)(JSON.stringify(entry));
  return response;
}

/** Logs the start of a sign-in: the PKCE challenge sent to Authentik, shortened as in the callback log. */
export function logSignInStart(request: Request, location: string): void {
  let challenge: string | null = null;
  let target: string | null = null;
  try {
    const url = new URL(location);
    challenge = url.searchParams.get('code_challenge')?.slice(0, LOG_PREFIX_LENGTH) ?? null;
    target = `${url.origin}${url.pathname}`;
  } catch {
    // An unparsable location is logged without a challenge.
  }
  console.info(JSON.stringify({ type: 'admin_auth_sign_in', challenge, target, ...requestContext(request.headers) }));
}
