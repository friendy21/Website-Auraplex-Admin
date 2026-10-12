import { NextRequest } from 'next/server';
import { getURLFromRedirectError } from 'next/dist/client/components/redirect';
import { isRedirectError } from 'next/dist/client/components/redirect-error';
import { workAsyncStorage } from 'next/dist/server/app-render/work-async-storage.external';
import { workUnitAsyncStorage } from 'next/dist/server/app-render/work-unit-async-storage.external';
import { createRequestStoreForAPI } from 'next/dist/server/async-storage/request-store';
import { createWorkStore } from 'next/dist/server/async-storage/work-store';

/**
 * A browser going through the real sign-in routes: GET /sign-in (run inside a
 * Next.js request scope, as its server-side signIn() needs) and the Auth.js
 * route that receives Authentik's redirect. The importing test sets the
 * environment first and imports 'next/dist/server/node-environment-baseline'
 * before anything else.
 */
export const ORIGIN = 'http://admin.example.test';
const HOST = { host: 'admin.example.test' };

/** Cookie request header from Set-Cookie headers, skipping removals. */
export function cookieHeader(setCookies: string[]): string {
  return setCookies
    .filter((cookie) => !/Max-Age=0/i.test(cookie))
    .map((cookie) => cookie.split(';', 1)[0])
    .join('; ');
}

/** GET /sign-in as a browser without a session: where it is sent, and the cookies it gets. */
export async function visitSignIn(search: string, headers: Record<string, string> = {}) {
  const { GET } = await import('../../app/sign-in/route');
  const request = new NextRequest(`${ORIGIN}/sign-in${search}`, { headers: { ...HOST, ...headers } });
  let setCookies: string[] = [];
  const workStore = createWorkStore({
    page: '/sign-in/route',
    renderOpts: { cacheComponents: false, supportsDynamicResponse: true, experimental: { isRoutePPREnabled: false, authInterrupts: false } },
    buildId: 'test',
    deploymentId: '',
    previouslyRevalidatedTags: [],
  } as never);
  const requestStore = createRequestStoreForAPI(
    request,
    { pathname: '/sign-in', search },
    { tags: [], expirationsByCacheKind: new Map() } as never,
    (cookies: string[]) => { setCookies = cookies; },
    undefined,
  );
  try {
    const response = await workAsyncStorage.run(workStore, () => workUnitAsyncStorage.run(requestStore, () => GET(request)));
    return { response, location: null, setCookies };
  } catch (error) {
    if (!isRedirectError(error)) throw error;
    return { response: null, location: getURLFromRedirectError(error), setCookies };
  }
}

/** Authentik's redirect arriving at the application's Auth.js route. */
export async function deliverCallback(callbackUrl: string, cookie: string, headers: Record<string, string> = {}) {
  const { GET } = await import('../../app/api/auth/[...nextauth]/route');
  return GET(new NextRequest(callbackUrl, { headers: { ...HOST, cookie, ...headers } }));
}
