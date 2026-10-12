/** The protected Admin workspace; `/` and `/admin` both redirect here. */
export const ADMIN_HOME_PATH = '/admin/upload';

/**
 * Public page shown after logout. It is deliberately not the Admin entry:
 * returning a signed-out browser to a protected route would start an Authentik
 * login again immediately.
 */
export const ADMIN_SIGNED_OUT_PATH = '/signed-out';

/**
 * Auth.js provider id. It fixes the OIDC callback path,
 * `/api/auth/callback/authentik`, which must match the redirect URI
 * registered on the Authentik provider exactly.
 */
export const AUTH_PROVIDER_ID = 'authentik';

/**
 * Public entry that starts the Authentik sign-in (app/sign-in/route.ts).
 * Auth.js v5 refuses a browser GET to `/api/auth/signin/<provider>`
 * (UnknownAction); a provider sign-in must be a POST with its CSRF token or
 * the server-side signIn(), which this route calls.
 */
export const ADMIN_SIGN_IN_PATH = '/sign-in';

/** Backslashes and control characters, which browsers may rewrite or strip. */
function hasUnsafeCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (character === '\\' || code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Only a same-origin absolute path is accepted as the place to return to
 * after sign-in. Anything else falls back to the Admin home: another origin,
 * `//host`, a backslash or control character (`/\t/host` can become
 * `//host`), and the sign-in machinery itself (`/sign-in`, `/api/auth/*`),
 * which would start another sign-in straight after this one, in a loop.
 */
export function safeCallbackPath(value: string | null | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || hasUnsafeCharacter(value)) return ADMIN_HOME_PATH;
  const path = value.split(/[?#]/, 1)[0];
  for (const reserved of [ADMIN_SIGN_IN_PATH, '/api/auth']) {
    if (path === reserved || path.startsWith(`${reserved}/`)) return ADMIN_HOME_PATH;
  }
  return value;
}

/** Where a browser without a session is sent to sign in. */
export function adminSignInPath(callbackPath: string): string {
  return `${ADMIN_SIGN_IN_PATH}?${new URLSearchParams({ callbackUrl: safeCallbackPath(callbackPath) })}`;
}
