/**
 * Response-header block the production ingress passes from this application.
 * Measured on 2026-10-12: a response whose headers exceed about 4 KB (nginx's
 * default proxy_buffer_size in front of the app) reaches the browser as a 502.
 */
export const GATEWAY_RESPONSE_HEADER_LIMIT_BYTES = 4096;

/**
 * The session cookie's Set-Cookie line rides on every authenticated response
 * (activity re-issues it), next to that response's own headers; it must leave
 * room for them under GATEWAY_RESPONSE_HEADER_LIMIT_BYTES. This is why the
 * session keeps neither the ID token nor the access token.
 */
export const SESSION_COOKIE_BUDGET_BYTES = 2048;

export function authSessionCookieName(production: boolean): string {
  return `${production ? '__Host-' : ''}authjs.session-token`;
}

export function authCookieConfig(production: boolean) {
  const prefix = production ? '__Secure-' : '';
  const options = {
    httpOnly: true,
    sameSite: 'lax' as const,
    path: '/',
    secure: production,
  };
  const transient = { ...options, maxAge: 15 * 60 };
  return {
    sessionToken: { name: authSessionCookieName(production), options },
    csrfToken: { name: `${production ? '__Host-' : ''}authjs.csrf-token`, options },
    callbackUrl: { name: `${prefix}authjs.callback-url`, options },
    pkceCodeVerifier: { name: `${prefix}authjs.pkce.code_verifier`, options: transient },
    state: { name: `${prefix}authjs.state`, options: transient },
    nonce: { name: `${prefix}authjs.nonce`, options: transient },
  };
}
