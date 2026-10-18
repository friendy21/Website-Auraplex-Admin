# AURA-INT-002 — Admin upload: Keycloak → Authentik

The identity provider is Authentik 2026.2.3 at `https://auth.auraplex.info`.
The session design is unchanged: the 30-minute idle and 12-hour absolute
limits, the 60-second refresh-token revalidation (rotation as Authentik's
Refresh Token threshold decides, see below),
group-based authorization in Proxy and in every handler, and RP-initiated
logout. Only the identity-provider wiring changed.

## Why sign-in failed on the first deployment

The staging error `[auth][error] UnknownAction: Unsupported action … at
Object.signin` had two causes, and fixing only the first would not have
removed it:

1. **Provider id.** The app registered the Auth.js provider `keycloak`, so it
   would have sent `redirect_uri=…/api/auth/callback/keycloak`, while the
   Authentik provider has `…/api/auth/callback/authentik` registered.
2. **GET sign-in.** Proxy and the admin page sent the browser to
   `GET /api/auth/signin/<provider>`. Auth.js v5 (`@auth/core` 0.41.3) answers
   that GET with `UnknownAction("Unsupported action")` for **every** provider
   id, configured or not (`lib/pages/index.js`, `render.signin`); a provider
   sign-in must be a POST with the CSRF token or the server-side `signIn()`.
   `tests/admin-sign-in.test.ts` reproduces the error with `authentik`
   configured.

Three further incompatibilities would each have stopped sign-in or
revalidation without an obvious error once those were fixed:

3. **Issuer trailing slash.** Authentik's issuer ends in `/`. The config
   loader stripped it, and both oauth4webapi (sign-in) and the revalidator
   compare the issuer exactly.
4. **Token endpoint outside the issuer path.** Authentik serves one token
   endpoint for all providers (`/application/o/token/`). The revalidator only
   accepted endpoints under the issuer path, so every 60-second revalidation
   would have been a 503.
5. **No refresh token without `offline_access`.** Authentik issues a refresh
   token only when `offline_access` is requested **and** the provider has that
   scope mapping. The app did not request it; without a refresh token the
   sign-in callback ended the session, and the browser would have been sent
   back to Authentik in a redirect loop.

## What changed in the application (approach A: names renamed)

| Area | Change |
| --- | --- |
| Provider | Generic OIDC provider, id `authentik`, everything from `<issuer>.well-known/openid-configuration`; `client_secret_basic`; scopes `openid email profile offline_access` (`lib/admin/server/auth-config.ts`). |
| Sign-in entry | New public route `/sign-in` (`app/sign-in/route.ts`) calls the server-side `signIn('authentik')`. Proxy and the admin page redirect there with a same-origin `callbackUrl`. |
| Issuer | Kept verbatim; discovery URL built per OIDC Discovery §4 (`lib/admin/server/config.ts`). |
| Revalidation | Token and JWKS endpoints must be on the issuer's origin (HTTPS in production), not under its path (`authentik-revalidation.ts`, was `keycloak-revalidation.ts`). |
| No refresh token | Sign-in is refused (Auth.js AccessDenied page) and logged as `{"type":"admin_sign_in","outcome":"rejected","reason":"no-refresh-token"}`, instead of looping. |
| Logout | Unchanged design; discovery URL fixed (`authentik-logout.ts`, was `keycloak-logout.ts`). Since the follow-up below it names the client (`client_id`) instead of sending an `id_token_hint`. |
| Claim check | `ADMIN_AUTH_DEBUG_CLAIMS=1` logs the structure of each validated ID token at sign-in and refresh (claim names; values of `iss`, `aud`, `groups` only). |
| Names | `KEYCLOAK_*` → `AUTHENTIK_*`; `keycloakSub` → `authentikSub` in the session JWT. Sessions issued by the Keycloak build cannot be revalidated and must sign in again; none could be established anyway. |
| Tests | The fake is `tests/helpers/fake-authentik.ts`, shaped like the live provider (per-provider issuer with `/`, shared authorize/token endpoints, RS256, no `refresh_expires_in`, the authorization-code leg with PKCE, `offline_access` mapping behaviour). |

## Follow-up: `invalid_grant` at the token exchange

After the first deployment, sign-in passed Authentik's authorize step and
failed in the callback: `CallbackRouteError` / "server responded with an error
in the response body" / `{ error: "invalid_grant", provider: "authentik" }`,
shown as Auth.js's Configuration error.

**Cause: A, the authorization code redeemed twice, because the first,
successful callback response could not pass the ingress.**

What was measured (2026-10-12):

| Check | Result |
| --- | --- |
| Live ingress, anonymous `/admin/<path>` whose redirect echoes the path | 307 with a 3,743-byte `Location`; **502** (Cloudflare `error code: 502`) from 3,943 bytes: a response whose headers exceed about 4,096 bytes never reaches the browser |
| Same, with a request that makes one outbound call (`/sign-in`) | the 502 comes back as fast as a normal answer: no automatic retry |
| Production build (`next build`, `NODE_ENV=production`) against an Authentik-shaped fake, one login | one code exchange, PKCE verifier matching the challenge, identical `redirect_uri` on both legs: **B and C do not occur** |
| Its callback response | **3,741 bytes** of headers, 2,924 of them the session cookie, 1,230 bytes of whose JSON was the stored ID token |
| Its first `/admin/upload` response (the cookie is re-issued on every authenticated response) | **3,702 bytes** |
| The same callback delivered a second time | `invalid_grant` → `error=Configuration`, the exact log lines reported |

The real ID token adds to that (a 32-hex key id, `sid`, `at_hash`, more
groups), which takes the callback response past the 4 KB limit: the browser
receives a 502 for a login that succeeded, and the next delivery of the same
callback (a reload, back/forward, a retry) presents the spent code.

**Fix**

- The session no longer stores the ID token (it was used only as the logout
  `id_token_hint`; logout now sends `client_id` and `post_logout_redirect_uri`,
  as OIDC RP-Initiated Logout allows). On the production build the callback
  response is now **2,077 bytes** and the first Admin page **2,038 bytes**;
  each further group adds about 30 bytes.
- A callback delivered again with the same code and the same browser's PKCE
  cookie, while the first is in flight or up to 5 minutes after it succeeded,
  gets the first response (`lib/admin/server/oidc-callback.ts`): the code is
  redeemed once. The PKCE cookie is HttpOnly and per browser, so the callback
  URL alone obtains nothing. Failures are not kept.
- Every sign-in start and callback is logged (no code, verifier or token):

  ```json
  {"type":"admin_auth_sign_in","challenge":"<first 12 of code_challenge>","cfRay":"…"}
  {"type":"admin_auth_callback","code":"<digest>","delivery":"first|concurrent|replayed|unkeyed","pkceCookies":1,"verifierChallenge":"<first 12>","status":302,"outcome":"session","headerBytes":2077,"ms":180,"cfRay":"…"}
  ```

  `verifierChallenge` equal to the sign-in `challenge` rules out B; the same
  `code` digest twice with different `cfRay` values shows a re-delivery (A);
  `headerBytes` above 3,072 is logged as a warning.
- `AUTH_DEBUG=true` now really turns on Auth.js's debug log (Auth.js reads no
  such variable itself). It prints cookies and the PKCE verifier: only briefly.

**Confirming on the live system** (one login is enough):

- The app log shows `admin_auth_sign_in` and `admin_auth_callback` with
  `outcome` `session`, and no `CallbackRouteError`.
- For the failures before this fix, the APISIX error log should contain
  `upstream sent too big header while reading response header from upstream`
  for `/api/auth/callback/authentik`, and Authentik's server log `Code does
  not exist` (a redeemed code) rather than `Code challenge not matching` (B).
- Recommended for ops regardless: `proxy_buffer_size 16k; proxy_buffers 8 16k;`
  on the ingress, as headroom.

## Follow-up: first upload refused with "could not be re-verified"

After sign-in worked, the first upload (the first request once the session's
last validation was 60 seconds old) got 503 `IDENTITY_PROVIDER_UNAVAILABLE`,
logged as `{"type":"admin_session_revalidation","outcome":"unavailable","reason":"protocol"}`.
A refresh-token grant made by hand from the container, with the session's
refresh token and the same client credentials, returned 200.

**Cause: the app required a new refresh token in every refresh answer;
Authentik does not always send one.** Authentik's token view renews a refresh
token, and revokes the one presented, only when that token has less than the
provider's **Refresh Token threshold** left to live (always when the threshold
is `seconds=0`, the default). Otherwise the answer has an access token and an
ID token but **no `refresh_token`**, and the presented token stays valid
(RFC 6749 §6 leaves a new refresh token to the server). The revalidator treated
that answer as a protocol failure, so every revalidation failed the same way
and the token was never spent, which is why the manual grant still succeeded.
Discovery, the JWKS (one RS256 key), client authentication (`client_secret_basic`)
and the request body (`grant_type` and `refresh_token` only, no `redirect_uri`
or `scope`) were all correct. With this code an `invalid_grant` from Authentik
ends the session (401); it is never logged as `unavailable`/`protocol`.

**Fix**

- An answer without `refresh_token` (or repeating the presented one) is a
  successful revalidation; the presented token is kept in the session. When
  Authentik does send a new one it replaces the stored token in the re-issued
  cookie, as before, and the revoked one is never presented again.
- A `refresh_token` that is present but not a non-empty string is still a
  protocol failure, and so is any ID-token problem.
- The `admin_session_revalidation` log line now carries a `detail` naming the
  step and check that failed, so `protocol` is no longer a dead end, for
  example `token:no-id-token`, `token:refresh-token-malformed`,
  `id-token:ERR_JWT_CLAIM_VALIDATION_FAILED:iss`, `discovery:issuer`,
  `token:invalid_client`, `token:http-503`. It never contains a token or a
  claim value.

**Confirming on the live system:** sign in, wait more than 60 seconds, upload a
PDF for a machines product. The upload succeeds, the object appears as
`auraplex-raw-pdf/machines/<slug>/<file>`, and there is no
`admin_session_revalidation` line. If one appears, its `detail` names the cause.

## Deployment: environment of the deployed job

| Before | After | Value |
| --- | --- | --- |
| `KEYCLOAK_ISSUER` | `AUTHENTIK_ISSUER` | `https://auth.auraplex.info/application/o/admin-upload-provider/` (with the trailing slash) |
| `KEYCLOAK_CLIENT_ID` | `AUTHENTIK_CLIENT_ID` | `2h09nO5KV46jz53vKyWxQzMJNv6Yxu0titxQFgXN` |
| `KEYCLOAK_CLIENT_SECRET` | `AUTHENTIK_CLIENT_SECRET` | Nomad variable `nomad/jobs/admin-upload`, field `keycloak_client_secret` (field name unchanged) |
| `KEYCLOAK_UPLOADER_ROLE` | `AUTHENTIK_UPLOADER_GROUP` | unset (default `auraplex-uploader`) |
| `KEYCLOAK_ADMIN_ROLE` | `AUTHENTIK_ADMIN_GROUP` | unset (default `auraplex-admin`) |
| — | `ADMIN_AUTH_DEBUG_CLAIMS` | `1` only while running the checks below, then remove |

The old names are not read. With only them in place nobody can sign in:
`/sign-in` answers 503 "Authentication is not configured", and the upload API
answers 503 `BACKEND_NOT_CONFIGURED` naming the missing `AUTHENTIK_*`
variables. `/api/health` stays green either way.

## Authentik provider: required settings

| Setting | Required | State on 2026-10-12 |
| --- | --- | --- |
| Redirect URI (strict) | `https://admin-auraplex.auraplex.info/api/auth/callback/authentik` | Accepted: an authorization request from the real `/sign-in` route was answered with a redirect to `default-authentication-flow`, not an error. |
| Scope mappings | `openid`, `email`, `profile`, **`offline_access`** | **Probably missing `offline_access`**: the discovery document's `scopes_supported` lists only `openid`, `email`, `profile`. Add "authentik default OAuth Mapping: OpenID 'offline_access'" to the provider. |
| Include claims in id_token | on | Not visible from outside; check 3 below confirms it. |
| Signing key | RS256 | Present: one RS256 key in the JWKS. |
| Client authentication | `client_secret_basic` | Supported per discovery. |
| Refresh Token validity / threshold | any; `seconds=0` threshold recommended | Not visible from outside. With threshold `seconds=0` every revalidation rotates the refresh token (a copied token stops working at the next refresh). With a larger threshold Authentik keeps the token until it nears expiry; the app accepts both. |
| Post-logout redirect | `https://admin-auraplex.auraplex.info/signed-out` accepted | Not visible from outside; check 6. |
| Invalidation flow | contains a User Logout stage (for example `default-invalidation-flow`) | Not visible from outside; check 6. Authentik's default provider invalidation flow is expected not to end the Authentik session. |
| Application binding | group bindings for `auraplex-uploader` and `auraplex-admin`, policy engine mode ANY | Confirmed in the ticket. |

## Live checks (acceptance)

None of these has been run: they need the client secret and real user
accounts, which this change did not use. Use three test users: **U** in
`auraplex-uploader` only, **A** in `auraplex-admin`, **N** in neither. Set
`ADMIN_AUTH_DEBUG_CLAIMS=1` on the job for checks 1 to 5.

| # | Check | Expected |
| --- | --- | --- |
| 1 | Anonymous `GET /admin/upload` | 307 to `/sign-in?callbackUrl=%2Fadmin%2Fupload`, then to `https://auth.auraplex.info/application/o/authorize/`. No `UnknownAction` in the app log. |
| 2 | Sign in as **U** | Back on `/admin/upload`, upload workspace open, no Delete. Upload a small PDF: succeeds. If instead the Auth.js "Access Denied" page appears and the log has `no-refresh-token`, the `offline_access` mapping is missing. |
| 3 | Find the `admin_id_token_claims` line with `"source":"sign-in"` for **U** | `iss` is the issuer above, `aud` the client ID, `groups` contains `auraplex-uploader`. Paste it into the PR (template below). |
| 4 | Sign in as **A**; delete the upload from check 2 | Delete is offered and succeeds. **N**: Authentik's binding refuses the login; if it ever lets **N** through, every Admin page answers 403 / Not Found and every Admin API 403. |
| 5a | While **U** is signed in, remove **U** from `auraplex-uploader` in Authentik; wait 60 s; reload | 403 (or a new sign-in, if Authentik refuses the refresh). A `"source":"refresh"` claims line without the group, or none if refused. |
| 5b | Sign **U** in again (group restored); deactivate **U** in Authentik; wait 60 s; reload | The session ends: pages redirect to `/sign-in`, APIs answer 401. Authentik's login then refuses **U**. |
| 6 | Sign out with the top-right button | The browser passes through `…/application/o/admin-upload-provider/end-session/` and lands on `/signed-out`. Then open `https://auth.auraplex.info/`: it must ask for a login. If it shows the user still signed in, the invalidation flow lacks a User Logout stage. |
| 7 | Remove `ADMIN_AUTH_DEBUG_CLAIMS` | No more `admin_id_token_claims` lines. |

### Claim structure for the PR

The log line already contains no token, subject or e-mail; paste it as is:

```json
{"type":"admin_id_token_claims","source":"sign-in","claims":{
  "acr":"<string>","amr":"<array(1)>","aud":"2h09nO5KV46jz53vKyWxQzMJNv6Yxu0titxQFgXN",
  "auth_time":"<number>","email":"<string>","email_verified":"<boolean>","exp":"<number>",
  "given_name":"<string>","groups":["auraplex-uploader"],"iat":"<number>",
  "iss":"https://auth.auraplex.info/application/o/admin-upload-provider/",
  "name":"<string>","nickname":"<string>","preferred_username":"<string>","sub":"<string>"}}
```

The block above shows the expected shape only. The claims besides `iss`, `aud`
and `groups` depend on the provider's mappings; what matters is that `groups`
is present, is named `groups`, and lists the group names.
