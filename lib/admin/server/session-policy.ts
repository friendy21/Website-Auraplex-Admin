/**
 * Admin session lifetime rules (AURA-INT-001): a session ends after 30 minutes
 * without authenticated admin activity, and never lives longer than 12 hours
 * after the original Authentik login. Activity refreshes `activeAt` only;
 * `loginAt` is fixed at sign-in, so refreshes cannot extend the 12-hour limit.
 * Separately, the Authentik groups in the session must have been revalidated
 * with Authentik within the last 60 seconds (see authentik-revalidation.ts).
 *
 * This module is pure (no Next/Auth.js imports). The Auth.js `jwt` callback
 * applies it, and Proxy, route handlers and the admin page all read sessions
 * through that same callback (see session.ts).
 */
export const ADMIN_SESSION_POLICY = Object.freeze({
  idleTimeoutSeconds: 30 * 60,
  absoluteLifetimeSeconds: 12 * 60 * 60,
});

/**
 * Authoritative freshness window: cached Authentik groups may be used for at
 * most this long after the last successful Authentik revalidation. It is a
 * separate rule from the idle timeout, the absolute lifetime and Authentik's
 * access-token lifespan, and is not derived from any of them.
 */
export const AUTHENTIK_REVALIDATION_WINDOW_SECONDS = 60;

/**
 * Set on the token and session for one read when revalidation was due but
 * Authentik could not be reached or trusted. It carries no identity; the session
 * loader turns it into a 503 and never persists it.
 */
export const REVALIDATION_UNAVAILABLE_FLAG = 'revalidationUnavailable';

/** `lastValidatedAt` is in epoch seconds and moves only on an Authentik success. */
export function isAuthentikRevalidationDue(
  lastValidatedAt: number,
  nowMs: number,
  windowSeconds = AUTHENTIK_REVALIDATION_WINDOW_SECONDS,
): boolean {
  const age = nowMs / 1000 - lastValidatedAt;
  // A validation time in the future is not trusted either.
  return !(age >= 0 && age < windowSeconds);
}

export type AdminSessionState ='valid' | 'missing-timestamps' | 'idle-expired' | 'absolute-expired';

/** Session timestamps stored in the encrypted Auth.js JWT, in epoch seconds. */
export interface AdminSessionClaims {
  loginAt?: unknown;
  activeAt?: unknown;
}

function epochSeconds(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

export function evaluateAdminSession(
  claims: AdminSessionClaims,
  nowMs: number,
  policy = ADMIN_SESSION_POLICY,
): AdminSessionState {
  const loginAt = epochSeconds(claims.loginAt);
  const activeAt = epochSeconds(claims.activeAt);
  // Tokens issued before these rules (or tampered ones) carry no timestamps.
  if (loginAt === null || activeAt === null) return 'missing-timestamps';
  const now = nowMs / 1000;
  if (now - loginAt >= policy.absoluteLifetimeSeconds) return 'absolute-expired';
  if (now - activeAt >= policy.idleTimeoutSeconds) return 'idle-expired';
  return 'valid';
}

/**
 * Auth.js `jwt` callback body. Returns the token with refreshed activity, or
 * null to end the session (Auth.js then clears the session cookie).
 */
export function applyAdminSessionPolicy<T extends Record<string, unknown>>(
  token: T,
  { signIn, nowMs }: { signIn: boolean; nowMs: number },
  policy = ADMIN_SESSION_POLICY,
): (T & { loginAt: number; activeAt: number }) | null {
  const now = Math.floor(nowMs / 1000);
  if (signIn) return { ...token, loginAt: now, activeAt: now };
  if (evaluateAdminSession(token, nowMs, policy) !== 'valid') return null;
  return { ...token, loginAt: token.loginAt as number, activeAt: now };
}
