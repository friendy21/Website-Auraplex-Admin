/**
 * RP-initiated logout (OIDC). Authentik publishes a per-provider
 * end_session_endpoint (`<issuer>end-session/`), inside the issuer path, which
 * runs the provider's invalidation flow. Whether that flow also ends the
 * Authentik SSO session (a User Logout stage) is Authentik configuration, and
 * `<AUTH_URL>/signed-out` must be allowed there as the post-logout redirect.
 */
import { ADMIN_SIGNED_OUT_PATH } from '@/lib/admin/admin-routes';
import { getAuthentikConfig, oidcDiscoveryUrl, type AuthentikConfig } from '@/lib/admin/server/config';

export interface LogoutDiscovery {
  end_session_endpoint?: unknown;
  issuer?: unknown;
}

export function buildAuthentikLogoutUrl(input: {
  issuer: string;
  clientId: string;
  idToken: string;
  endpoint: string;
  postLogoutRedirectUri: string;
}): string {
  const issuer = new URL(input.issuer);
  const endpoint = new URL(input.endpoint);
  const redirect = new URL(input.postLogoutRedirectUri);
  if (endpoint.origin !== issuer.origin || !endpoint.pathname.startsWith(`${issuer.pathname.replace(/\/$/, '')}/`)) {
    throw new Error('Authentik logout endpoint is outside the configured issuer');
  }
  if (process.env.NODE_ENV === 'production' && (endpoint.protocol !== 'https:' || redirect.protocol !== 'https:')) {
    throw new Error('Production logout must use HTTPS');
  }
  endpoint.searchParams.set('client_id', input.clientId);
  endpoint.searchParams.set('id_token_hint', input.idToken);
  endpoint.searchParams.set('post_logout_redirect_uri', redirect.toString());
  return endpoint.toString();
}

export async function discoverAuthentikLogoutUrl(
  idToken: string,
  fetcher: typeof fetch = fetch,
  config: AuthentikConfig = getAuthentikConfig(),
  appOrigin: string | undefined = process.env.AUTH_URL?.trim(),
): Promise<string> {
  if (!appOrigin) throw new Error('AUTH_URL is required for full logout');
  const response = await fetcher(oidcDiscoveryUrl(config.issuer), {
    cache: 'no-store',
    signal: AbortSignal.timeout(1_500),
  });
  if (!response.ok) throw new Error('Authentik discovery unavailable');
  const discovery = await response.json() as LogoutDiscovery;
  if (discovery.issuer !== config.issuer || typeof discovery.end_session_endpoint !== 'string') {
    throw new Error('Authentik logout discovery is invalid');
  }
  return buildAuthentikLogoutUrl({
    issuer: config.issuer,
    clientId: config.clientId,
    idToken,
    endpoint: discovery.end_session_endpoint,
    postLogoutRedirectUri: new URL(ADMIN_SIGNED_OUT_PATH, appOrigin).toString(),
  });
}

export async function tryDiscoverAuthentikLogoutUrl(
  idToken: string | undefined,
  discover: (token: string) => Promise<string> = discoverAuthentikLogoutUrl,
): Promise<string | null> {
  if (!idToken) return null;
  try {
    return await discover(idToken);
  } catch {
    // The caller must still clear its local session. Upstream SSO logout is
    // unconfirmed when discovery is unavailable.
    return null;
  }
}
