import { redirect } from 'next/navigation';
import type { NextRequest } from 'next/server';
import { signIn } from '@/auth';
import { AUTH_PROVIDER_ID, safeCallbackPath } from '@/lib/admin/admin-routes';
import { getAuthentikConfig } from '@/lib/admin/server/config';
import { assertAdminNodeRuntime } from '@/lib/admin/server/node-runtime';
import { logSignInStart } from '@/lib/admin/server/oidc-callback';

/**
 * Starts the Authentik sign-in for a browser that Proxy or the admin page
 * found without a session. Auth.js v5 answers a browser GET to
 * `/api/auth/signin/<provider>` with UnknownAction, so the authorization
 * request is built here by the server-side signIn(): it sets the state and
 * PKCE cookies and redirects to Authentik's authorization endpoint. Public:
 * it reads no session, and the OIDC callback completes in the Auth.js route.
 */
export async function GET(request: NextRequest): Promise<Response> {
  assertAdminNodeRuntime();
  try {
    getAuthentikConfig();
  } catch {
    return new Response('Authentication is not configured', { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
  // signIn() sets the PKCE cookie either way; the redirect is made here so the
  // challenge it sends can be logged for comparison with the callback.
  const location: string = await signIn(AUTH_PROVIDER_ID, {
    redirectTo: safeCallbackPath(request.nextUrl.searchParams.get('callbackUrl')),
    redirect: false,
  });
  logSignInStart(request, location);
  redirect(location);
}
