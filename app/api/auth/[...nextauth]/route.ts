import type { NextRequest } from 'next/server';
import { handlers } from '@/auth';
import { withBrowserInstance } from '@/lib/admin/server/browser-instance';
import { withOidcCallback } from '@/lib/admin/server/oidc-callback';

// Both methods go through the same wrapper. Sign-in completes in this route
// (the OIDC callback), so this is where a new login is tied to the browser it
// came from; and Auth.js writes the session cookie here itself (session,
// sign-out), so this is where those writes get the common commit rule.
// The OIDC callback is additionally logged and protected against redeeming
// its authorization code twice (see oidc-callback.ts).
export const GET = (request: NextRequest) =>
  withOidcCallback(request, () => withBrowserInstance(request, handlers.GET));
export const POST = (request: NextRequest) => withBrowserInstance(request, handlers.POST);
