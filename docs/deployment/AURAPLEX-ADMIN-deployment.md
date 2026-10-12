# Auraplex Admin — Deployment Readiness

This document covers what is needed to deploy the standalone Auraplex Admin
application. Three words are used with fixed meanings throughout:

- **Confirmed** — a value Friendy supplied.
- **Wired** — a value that is present in configuration in this repository.
- **Deployed** — running in production or staging. Nothing is.

[Section D](#d-confirmed-deployment-values) lists every confirmed value and
whether it is wired. What is still open is in [section E](#e-unresolved);
none of it has been guessed. No secret value is stored in this repository.
[Section G](#g-handoff-to-friendy) is the working list for taking the
application to staging and production.

Friendy has confirmed that he handles the remaining infrastructure and
deployment work: Vault, the MinIO and Qdrant runtime configuration, Nomad
networking, Docker image publishing, APISIX and Cloudflare, and the staging
and production deployments. No application-side decision is outstanding.

Detailed runtime and security behaviour is in
[AURA-INT-001-runtime.md](AURA-INT-001-runtime.md). The original design is in
[the RFC](../rfc/AURA-INT-001-admin-upload.md). The move from Keycloak to
Authentik, and the checks that must be run against live Authentik, are in
[AURA-INT-002-authentik.md](AURA-INT-002-authentik.md).

**Status: not deployed. There has been no production deployment and no
staging deployment. Nothing in this repository has been run against real
Authentik, MinIO, Qdrant, APISIX, Cloudflare Tunnel or Nomad.**

## A. Implemented in code

- **Routes.** `/` and `/admin` redirect to `/admin/upload`; `/signed-out` is
  the public logout landing page; `/api/admin/*` and `/api/auth/*` serve the
  Admin APIs and Auth.js. There are no other pages.
- **Liveness endpoint.** `GET /api/health` returns `200` with
  `{"status":"ok","service":"auraplex-admin"}` and `Cache-Control: no-store`.
  It is public, reads no session and contacts neither Authentik, MinIO nor
  Qdrant. It reports only that the server process is answering; it is not a
  readiness check for those services.
- **Authentication guard.** `proxy.ts` protects `/admin/*` and `/api/admin/*`
  except `/api/admin/uploads`, whose Route Handler authenticates each request
  itself so that large bodies are streamed rather than buffered.
- **Session rules.** 30-minute idle timeout, 12-hour absolute lifetime, and
  re-verification with Authentik once the last verification is 60 seconds old,
  with mandatory refresh-token rotation. What happens when a re-verification
  does not succeed depends on why; see
  [Re-verification outcomes](#re-verification-outcomes).
- **Upload contract.** Object key `{ingest_line}/{product.slug}/{sanitized_filename}`,
  Qdrant `source_key` `{bucket}/{key}`, three fixed buckets and three fixed
  collections. See the README.
- **Container image.** `Dockerfile` builds the Next.js standalone server on
  `node:22-slim`, needs no secrets at build time, and runs as the unprivileged
  `node` user. `PORT` and `HOSTNAME` default to `3000` and `0.0.0.0`.
- **Nomad job draft.** `deploy/admin.nomad.hcl` is a draft of the production
  job with the confirmed identity and a health check on `/api/health`. It is
  not production-ready and must not be submitted; see
  [The Nomad job draft](#the-nomad-job-draft). There is no staging job.

## B. Validated locally

Validated with automated tests and local builds only:

- `npm ci`, `npm run typecheck`, `npm run lint`, `npm run build`.
- The automated test suite (`npm test`), which uses an in-process fake
  Authentik and an in-process S3 endpoint.
- The built server answering the routes above over HTTP on a developer
  machine, with throwaway credentials.

**Not validated:**

- A Docker image build. Docker was not available where this was prepared, so
  the image has never been built or started. A real `docker build` and a
  container smoke test (start it, `GET /api/health`, confirm the process runs
  as the `node` user) are required before deployment.
- `deploy/admin.nomad.hcl`. Nomad was not available either, so the file has
  not been through `nomad job validate` or `nomad job plan`.
- Everything in sections C to G.

## C. Requires production configuration

### Environment

All variables are listed in `.env.example`. Every one is read at runtime
except `NEXT_PUBLIC_ADMIN_UPLOAD_MAX_MB`. They are not all mandatory. The
classification below follows what the code does when a variable is missing;
no variable is validated at startup, so a missing one shows up only when the
feature that needs it is used.

**A. Required for authentication**

| Variable | If missing |
| --- | --- |
| `AUTH_SECRET` | Every protected route answers 503. |
| `AUTHENTIK_ISSUER`, `AUTHENTIK_CLIENT_ID`, `AUTHENTIK_CLIENT_SECRET` | Required together with `AUTH_SECRET`. Sign-in is impossible and protected requests are refused. The `KEYCLOAK_*` names used before AURA-INT-002 are no longer read. |
| `AUTH_URL` | Not checked by the code. Logout cannot build the Authentik logout redirect, so it clears the local session only and the Authentik session stays open. Set it in every environment behind the ingress. |

**B. Required for upload and storage**

| Variable | If missing |
| --- | --- |
| `MINIO_ENDPOINT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY` | Uploads, the recent uploads list and delete answer 503 `BACKEND_NOT_CONFIGURED`. |

**C. Required for complete Qdrant functionality**

| Variable | If missing |
| --- | --- |
| `QDRANT_URL` | Uploads and the list still work. Processing status is unavailable and delete is refused, because a delete must remove the Qdrant points as well. |

**D. Optional or defaulted**

| Variable | Default |
| --- | --- |
| `AUTHENTIK_UPLOADER_GROUP`, `AUTHENTIK_ADMIN_GROUP` | `auraplex-uploader`, `auraplex-admin` |
| `ADMIN_AUTH_DEBUG_CLAIMS` | off. `1` logs the structure of each validated ID token (claim names; values of `iss`, `aud` and `groups` only). For verifying the Authentik provider. |
| `MINIO_REGION` | `us-east-1` |
| `ADMIN_UPLOAD_MAX_MB` | 100 (the application fallback, used in development and testing); range 1–500. Production is confirmed as 300 and set in the job. |
| `ADMIN_UPLOAD_MAX_CONCURRENT` | 4 per process; range 1–16 |
| `PORT`, `HOSTNAME` | `3000` and `0.0.0.0`, set by the image |

**E. Conditional**

| Variable | Set only when |
| --- | --- |
| `QDRANT_API_KEY` | the Qdrant deployment requires a key. |
| `ADMIN_TRUSTED_PROXY_SECRET` | the ingress strips any client-supplied `x-auraplex-proxy-secret` header and injects its own. See the runtime notes first. |
| `NEXT_PUBLIC_ADMIN_UPLOAD_MAX_MB` | the UI must show a lower ceiling than the server cap. Build-time and UI-only; normally unset. For the production build it must be unset or `300`; see [G7](#g7-upload-limits). |

`AUTH_URL` must be the exact public origin users reach, with no trailing
slash. In production it must be HTTPS: the logout redirect is refused
otherwise, and the session cookies use the `__Host-` prefix.

Confirmed values, and where each one is wired:

| Variable | Confirmed value | Wired |
| --- | --- | --- |
| `AUTH_URL` (production) | `https://admin-auraplex.auraplex.info` | yes, in `deploy/admin.nomad.hcl` |
| `AUTH_URL` (staging) | `https://admin-auraplex-staging.auraplex.info` | no; documented only, no staging job exists |
| `AUTHENTIK_ISSUER` | `https://auth.auraplex.info/application/o/admin-upload-provider/` (the trailing slash is part of it) | yes, in `deploy/admin.nomad.hcl` |
| `AUTHENTIK_CLIENT_ID` | `2h09nO5KV46jz53vKyWxQzMJNv6Yxu0titxQFgXN` | yes, in `deploy/admin.nomad.hcl` |
| `AUTHENTIK_CLIENT_SECRET` | source only: Nomad variable below | no; injected by the deployed job, not by this draft |
| `ADMIN_UPLOAD_MAX_MB` (production) | `300` | yes, in `deploy/admin.nomad.hcl` |

One issuer and one client ID were supplied, with no separate staging client.
No value or source has been supplied for `AUTH_SECRET`, the MinIO variables
or the Qdrant variables; see [section E](#e-unresolved).

### Secrets

| Secret | Source |
| --- | --- |
| `AUTHENTIK_CLIENT_SECRET` | Nomad variable `nomad/jobs/admin-upload`, field `keycloak_client_secret` (the field keeps its Keycloak-era name) |
| `AUTH_SECRET` | not supplied; required for authentication |
| `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY` | not supplied; required for upload and storage |
| `QDRANT_API_KEY` | not supplied; needed only if Qdrant requires a key |

The Nomad variable is a reference only. No secret value, real or invented,
belongs in the job file, `.env.example`, the image or this document. Local
`.env` files are excluded from the Docker build context by `.dockerignore`.

The deployed job renders that field into the environment; that job is
Friendy's and is not this draft. Since AURA-INT-002 the field must be rendered
as `AUTHENTIK_CLIENT_SECRET` (it was `KEYCLOAK_CLIENT_SECRET`); the field name
itself does not change. `deploy/admin.nomad.hcl` carries a TODO instead of
guessed syntax.

### The Nomad job draft

`deploy/admin.nomad.hcl` is a draft of the production job. It is **not
production-ready and must not be submitted to Nomad.**

- That is a rule for people, not a technical lock. The file is meant to be
  well-formed HCL, so Nomad may accept it and schedule the job. Nothing in it
  disables it.
- Missing secrets would not stop it. The server process starts without them
  and `GET /api/health` answers 200, so the allocation can look healthy while
  nobody can sign in and nothing can be uploaded. A passing health check is
  not evidence that the deployment works.
- The blockers are listed at the top of the file and in
  [section E](#e-unresolved).
- It has not been validated: `nomad job validate` has not been run on it.
- It is the production job only. No staging job exists.

### Authentik provider

OAuth2/OpenID provider `admin-upload-provider` on `https://auth.auraplex.info`
(Authentik 2026.2.3), confidential client
`2h09nO5KV46jz53vKyWxQzMJNv6Yxu0titxQFgXN`. `<AUTH_URL>` stands for the public
origin of the environment. Every endpoint is read from the issuer's discovery
document, `<issuer>.well-known/openid-configuration`; none is configured.

| Setting | Value |
| --- | --- |
| Redirect URI (callback), strict | `<AUTH_URL>/api/auth/callback/authentik`. The Auth.js provider id is `authentik`. |
| Post-logout redirect URI | `<AUTH_URL>/signed-out` must be accepted for RP-initiated logout. |
| Client authentication | Confidential client with a secret; the token endpoint is called with HTTP Basic (`client_secret_basic`). |
| Scopes requested | `openid email profile offline_access` |
| Scope mappings on the provider | `openid`, `email`, `profile` **and `offline_access`**. Authentik issues a refresh token only for `offline_access`, and silently drops a requested scope that has no mapping. Without it every sign-in is refused, logged as `admin_sign_in` / `no-refresh-token`. |
| Refresh tokens | Issued at sign-in and **rotated on every use**. A refresh that returns no new token is treated as a failure. |
| ID token claims | "Include claims in id_token" stays on: `groups` (the default `profile` mapping, the names of the user's groups) must be in the ID token at sign-in and on every refresh. Access is decided by group membership only. A user who is only in a child group of `auraplex-admin` is not listed under that name. |
| Signing key | An RS256 key, published in the provider's JWKS. |
| Subject mode | Leave as configured: `sub` is the key for upload ownership, so changing the subject mode later detaches users from their uploads. |
| Invalidation flow | Must contain a User Logout stage for logout to end the Authentik session; see [Logout](#logout). |
| Application binding | Only members of `auraplex-uploader` or `auraplex-admin` (policy engine mode ANY). The application checks the groups again itself. |

Session and token timings the application relies on:

| Item | Value | Where it is set |
| --- | --- | --- |
| Access token validity | not relied on; the access token is not kept | Authentik provider |
| Refresh token validity | at least 30 minutes, the idle timeout; a shorter validity ends idle sessions early | Authentik provider |
| Authoritative re-verification | every 60 seconds | fixed in code |
| Session idle timeout | 30 minutes | fixed in code |
| Session absolute lifetime | 12 hours | fixed in code |

The application does not keep the access token. Removing a user's group,
deactivating the user or ending their Authentik session takes effect at the
next re-verification, within 60 seconds.

### Re-verification outcomes

The application does **not** contact Authentik on every request. While the
last verification is less than 60 seconds old, the groups stored in the
encrypted session cookie are used. Once it is 60 seconds old or more, the
next authenticated request redeems the refresh token at Authentik before
anything privileged runs. The result of that call decides what happens:

| Authentik outcome | Result |
| --- | --- |
| Authentik cannot be reached, times out, answers with a server error, or rejects the request for a reason other than the refresh token itself (for example a client misconfiguration) | Fail closed: **503** `IDENTITY_PROVIDER_UNAVAILABLE`. The stored groups are not used. The session cookie is left as it is, so the browser can retry. |
| The response is malformed, carries no new refresh token, or its ID token fails verification | The same **503**. Nothing from the response is trusted. |
| Authentik explicitly rejects the refresh token (`invalid_grant`: the token is unknown, expired or revoked; ending the user's Authentik session or deactivating the user is expected to cause this, to be confirmed live per [AURA-INT-002](AURA-INT-002-authentik.md)) | The session is no longer valid: the local session is cleared, APIs answer **401** `UNAUTHENTICATED`, pages redirect to sign-in, and the user must authenticate again. |
| The refresh succeeds but the fresh groups no longer include a required group | Access is denied: **403** `FORBIDDEN`. (If Authentik itself refuses the refresh because the user no longer passes the application binding, the row above applies instead.) |

A Authentik outage therefore blocks Admin use within 60 seconds, for as long
as it lasts, without signing anyone out.

### Logout

Signing out always clears the local Auth.js session and always ends on
`/signed-out`. What happens to the Authentik SSO session depends on the path
taken:

- **Normal path.** The application finds the provider's `end_session_endpoint`
  (`<issuer>end-session/`) through OIDC discovery and sends the browser there
  with the server-held ID token, `client_id` and
  `post_logout_redirect_uri=<AUTH_URL>/signed-out`. Authentik then runs the
  provider's invalidation flow. The Authentik SSO session ends only if that
  flow contains a User Logout stage; Authentik's default provider invalidation
  flow is expected not to, and would leave the user signed in to Authentik.
  The application does not verify which happened.
- **Fallback path.** If discovery cannot be completed in time, or no ID token
  is held, the application still clears the local session and sends the
  browser straight to `/signed-out`. Authentik is not involved, so the SSO
  session is **not** known to have ended, and nothing should describe it as
  ended. The user may still be signed in to Authentik and to other
  applications that use it.

### Ingress

Traffic reaches the application through Node → APISIX → Cloudflare Tunnel.
Neither hostname is routed yet. When they are, each must reach the Admin
service of its environment:

| Environment | Public hostname | Must route to |
| --- | --- | --- |
| Production | `admin-auraplex.auraplex.info` | Consul service `admin-upload`, internal port `3000` |
| Staging | `admin-auraplex-staging.auraplex.info` | a staging Admin service that does not exist yet |

The APISIX route definitions and the Cloudflare Tunnel configuration are not
in this repository, and none is invented here. Only the production Nomad
identity was supplied; no staging job, node or image was, so the staging
hostname is documented and nothing more.

`3000` is the port the application listens on. Which host port APISIX must
reach is a separate, unresolved question; see [section E](#e-unresolved).

- The route must forward request bodies up to the configured upload size
  without buffering them, and must not cut long-running uploads short.
- `/api/health` and `/signed-out` must be reachable without authentication.
- `ADMIN_TRUSTED_PROXY_SECRET` may only be set if the ingress strips any
  client-supplied `x-auraplex-proxy-secret` header and injects its own.

### Storage and search

- The MinIO access key needs the permissions in
  [minio-admin-upload-policy.json](minio-admin-upload-policy.json) on
  `auraplex-raw-pdf`, `auraplex-raw-image` and `auraplex-raw-video`.
- An incomplete-multipart lifecycle rule should exist on all three buckets.
- Qdrant must allow read and delete on `auraplex_machines`,
  `auraplex_software` and `auraplex_consulting`.

### Single instance and restarts

The application must run as **one instance**. Part of its state lives only in
the memory of the Node.js process, is not shared between processes and is not
written anywhere. Running several instances, or load-balancing across them,
is not supported until that is redesigned.

`count = 1` in the job limits the steady state. On its own it does not
guarantee that an old and a new allocation never run at the same moment
while the job is being updated or rescheduled. The draft defines no update
policy, and no rollout behaviour has been tested. Canary and scaling
settings must not be added; whether an update policy is needed to rule out
overlap is open.

A process restart is **not** transparent. Two kinds of state behave
differently:

**Survives a restart**, because it is carried in the browser's encrypted
session cookie and not in the server: the signed-in identity, the stored
groups, the sign-in time and last-activity time behind the 30-minute and
12-hour limits, the time of the last Authentik verification, and the Authentik
refresh token.

**Lost on a restart**, because it is process-local:

- upload rate-limit event history;
- upload byte reservations for the hourly volume limit;
- upload concurrency counters;
- coordination of refreshes in flight (single-flight);
- the short-lived cache of successful refresh results (reusable for 10
  seconds by requests still carrying the previous cookie);
- login-generation and browser ordering records, which decide whose response
  may write the session cookie;
- the in-memory caches of Authentik discovery metadata and signing keys
  (JWKS).

Consequences of a restart:

- Uploads in progress are cut off and must be retried.
- Rate and volume limits start counting again from zero, so the limits are
  briefly looser than configured.
- A signed-in user whose cookie is still within its limits can usually carry
  on. Their next request is judged as described under
  [Re-verification outcomes](#re-verification-outcomes): Authentik is
  contacted only if the last verification is 60 seconds old or more, not on
  every request.
- Users **may need to authenticate again**. This happens when the cookie has
  passed a limit, when Authentik refuses the refresh token, or when a response
  carrying a rotated refresh token was lost in the restart so that the
  browser still holds a token Authentik has already consumed.
- The ordering protection for overlapping responses starts empty: until new
  records exist, a late response from before the restart is not recognised
  as stale.

None of the lost state authenticates anyone. A restart does not let a request
through that the session limits or Authentik would refuse. It also provides no
continuity across instances: nothing here is cluster-wide.

## D. Confirmed deployment values

Confirmed by Friendy. These are settled and are not open questions. "Wired"
says whether the value is present in configuration in this repository. None
of it is deployed.

| Item | Confirmed value | Wired |
| --- | --- | --- |
| Production hostname | `admin-auraplex.auraplex.info` | yes, as `AUTH_URL` in the job draft |
| Staging hostname | `admin-auraplex-staging.auraplex.info` | no; documented only |
| Ingress path | Node → APISIX → Cloudflare Tunnel | no; not in this repository |
| Identity provider | Authentik 2026.2.3 at `https://auth.auraplex.info`, replacing Keycloak (AURA-INT-002) | n/a |
| Authentik provider slug | `admin-upload-provider` | yes, as part of the issuer |
| Authentik issuer | `https://auth.auraplex.info/application/o/admin-upload-provider/` | yes |
| Authentik client ID | `2h09nO5KV46jz53vKyWxQzMJNv6Yxu0titxQFgXN` | yes |
| Authentik client type | confidential | n/a; an Authentik-side setting |
| Authentik client secret source | Nomad variable `nomad/jobs/admin-upload`, field `keycloak_client_secret` | no; referenced in a comment only |
| Admin groups | `auraplex-uploader`, `auraplex-admin` | yes, as the application defaults |
| Nomad job name | `admin-upload` | yes |
| Nomad task group | `web` | yes |
| Consul service name | `admin-upload` | yes |
| Internal application port | `3000` | yes |
| Datacenter | `acumen-local` | yes |
| Node placement | `auraplex01`, by constraint on `${node.unique.name}` | yes |
| Container image | `auraplex.local/admin-upload:v1` | yes; the image itself has not been built |
| Resources | CPU `500`, memory `512` MB | yes |
| Deployment model | single instance | yes, `count = 1` |
| Production upload cap | 300 MB | yes, `ADMIN_UPLOAD_MAX_MB = "300"` in the job draft |
| Authentik redirect URI | `https://admin-auraplex.auraplex.info/api/auth/callback/authentik`, registered | yes; provider id `authentik` in the application |
| Remaining infrastructure and deployment work | handled by Friendy | n/a |

"Wired" means present in `deploy/admin.nomad.hcl`, which is a draft of the
production job. There is no staging job.

### Authentik callback and logout URIs

The application's Auth.js provider id is `authentik`, so it completes sign-in
on `/api/auth/callback/authentik`: the redirect URI registered on the
Authentik provider. It starts sign-in on its own public `/sign-in` route,
because Auth.js v5 refuses a browser GET to `/api/auth/signin/<provider>`
(the `UnknownAction` seen on the first deployment).

| | Registered on the provider | Sent by the application |
| --- | --- | --- |
| Production callback | `https://admin-auraplex.auraplex.info/api/auth/callback/authentik` | `https://admin-auraplex.auraplex.info/api/auth/callback/authentik` |
| Production logout | to be confirmed | post-logout redirect to `https://admin-auraplex.auraplex.info/signed-out` |
| Staging callback | not registered | `https://admin-auraplex-staging.auraplex.info/api/auth/callback/authentik` |
| Staging logout | not registered | post-logout redirect to `https://admin-auraplex-staging.auraplex.info/signed-out` |

- Authentik compares the redirect URI strictly, so scheme, host and path must
  match exactly.
- The application has no `/api/auth/callback` route without the provider
  segment and no `/api/auth/logout` route. The URLs supplied for the Keycloak
  client under AURA-INT-001 no longer apply.
- Sign-in and logout against the real provider are checks 4 and 8 in
  [section F](#f-production-smoke-tests).

## E. Unresolved

Nothing below has been guessed or changed in code. Friendy has confirmed that
he handles the remaining infrastructure and deployment work, which covers
every item here: Vault, the MinIO and Qdrant runtime configuration, Nomad
networking, Docker image publishing, APISIX and Cloudflare, and the staging
and production deployments. None of them needs an application-side decision.

The two questions that were open on the application side are settled and are
recorded in [section D](#d-confirmed-deployment-values): the callback URI,
now the registered Authentik one, and the production upload cap of 300 MB.

### Open items

| # | Item | State |
| --- | --- | --- |
| 1 | Ingress limits for the 300 MB upload cap | The cap itself is decided: 300 MB, set as `ADMIN_UPLOAD_MAX_MB` in the job. Not verified: that APISIX and Cloudflare pass request bodies of at least that size. Cloudflare's request-body limit depends on the plan; see the [runtime notes](AURA-INT-001-runtime.md). |
| 2 | Nomad injection of `AUTHENTIK_CLIENT_SECRET` | Source confirmed: Nomad variable `nomad/jobs/admin-upload`, field `keycloak_client_secret`, injected by the deployed job (Friendy's). Since AURA-INT-002 that job must render the field as `AUTHENTIK_CLIENT_SECRET`, and set `AUTHENTIK_ISSUER` and `AUTHENTIK_CLIENT_ID` instead of the `KEYCLOAK_*` names. Not in this draft. |
| 3 | `AUTH_SECRET` | Value and source not supplied. |
| 4 | MinIO endpoint, access key and secret key | Not supplied. The three buckets must exist and the key needs the documented policy. |
| 5 | Qdrant URL and, if required, API key | Not supplied. |
| 6 | APISIX route definitions | Not in this repository. |
| 7 | Cloudflare Tunnel ID and configuration | Not in this repository. |
| 8 | Host port and network mapping | Confirmed: the application listens on internal port 3000. Not confirmed: that the host port must be statically bound to 3000. The draft keeps host networking and a static port from the reviewed template, which makes 3000 the host port on `auraplex01` too; the public website has been documented as listening on host port 3000. A dynamic host port mapped to internal port 3000 would fit what was confirmed equally well. The draft's networking is unchanged until this is answered. |
| 9 | Upload concurrency at 512 MB | The default of 4 concurrent uploads was measured against a 1024 MB task. It is unchanged; whether it fits in 512 MB has not been measured. |
| 10 | Staging deployment identity | Only the staging hostname was supplied. No staging job, node or image is defined. |
| 12 | Overlap during job updates | `count = 1` does not by itself rule out an old and a new allocation running briefly together. No update policy is defined and none has been tested. |
| 13 | Nomad validation | `nomad job validate` has not been run on the draft. |
| 11 | That the real provider issues rotated refresh tokens and puts `groups` in sign-in and refreshed ID tokens | Not verified against live Authentik. Its discovery document (checked 2026-10-12) lists only the `openid`, `email` and `profile` scopes, so the `offline_access` mapping appears to be missing and no refresh token would be issued. See [AURA-INT-002](AURA-INT-002-authentik.md). |
| 14 | Authentik post-logout redirect and invalidation flow | Not verified: that `<AUTH_URL>/signed-out` is accepted as the post-logout redirect, and that the provider's invalidation flow ends the Authentik session. See [Logout](#logout). |

Also outstanding before sign-off: the Docker build and container smoke test
described in section B, and triage of the open `npm audit` findings in
[the dependency review](AURA-INT-001-dependency-review.md).

## F. Production smoke tests

To be run once, after the first deployment, against the real environment.
None has been run.

| # | Check | Expected |
| --- | --- | --- |
| 1 | `GET /api/health` | 200 with the fixed JSON body |
| 2 | Anonymous `GET /signed-out` | 200 |
| 3 | Anonymous `GET /admin/upload` | Redirect to `/sign-in`, then to Authentik's authorization endpoint; no `UnknownAction` in the log |
| 4 | Sign in as a user in the uploader or admin group | Upload workspace opens |
| 5 | Sign in as a user in neither group | Refused by the Authentik application binding; if the binding lets the user through, the application answers 403 |
| 6 | Remove a signed-in user's group in Authentik | Access denied (403) within 60 seconds |
| 7 | End a signed-in user's Authentik session, or disable the user | Within 60 seconds the user is signed out and must authenticate again |
| 8 | Sign out (normal path) | The browser passes through Authentik's end-session endpoint and lands on `/signed-out`; the local session is cleared. Then confirm the Authentik session has ended (opening `https://auth.auraplex.info/` asks for a login again): the application does not verify this itself |
| 9 | Sign out while Authentik discovery is unreachable from the application (fallback path), if this can be arranged safely | The browser still lands on `/signed-out` and the local session is cleared. The Authentik SSO session is **not** expected to have ended; do not record it as ended |
| 10 | Upload a small PDF | Succeeds |
| 11 | Upload at the configured size limit, and just over it (300 MB in production) | At the limit succeeds; over it is rejected |
| 12 | Upload a file whose contents do not match its type | Rejected |
| 13 | Upload with no product selected | Rejected |
| 14 | Inspect the stored object in MinIO | Bucket and key follow `{ingest_line}/{product.slug}/{sanitized_filename}` |
| 15 | Check the upload's status against Qdrant | Pending until evidence exists, then processed (PDF) |
| 16 | Open the recent uploads list | The upload is listed; uploaders see only their own |
| 17 | Delete the upload as an admin | Qdrant points and the MinIO object are removed |
| 18 | Read the application log | An audit line exists for each upload and delete |
| 19 | Restart the container, then repeat checks 1, 3 and 10 | The same results. A user who was signed in either continues or is asked to sign in again; both are acceptable. An upload that was in progress during the restart fails and must be retried. See [Single instance and restarts](#single-instance-and-restarts) |

## G. Handoff to Friendy

This section is the working list for whoever takes the application to staging
and production. It repeats nothing as settled that is still open: every open
item points back to [section E](#e-unresolved).

**State at handoff.** The application is feature-complete and its automated
tests pass. It has not been deployed anywhere. The image has never been
built, and `deploy/admin.nomad.hcl` is a draft that has never been validated
and is **not safe to submit as it is**.

### Responsibility

Friendy has confirmed that he handles the remaining infrastructure and
deployment work:

- Vault;
- the MinIO and Qdrant runtime configuration;
- Nomad networking;
- Docker image publishing;
- APISIX and Cloudflare;
- the staging and production deployments.

Nothing in that list is resolved or guessed in this repository. The sections
below record what the application needs from each, so that the work can be
done from one place.

Settled since the first handoff, with no application change needed:

- **Authentik callback URI.** `<AUTH_URL>/api/auth/callback/authentik` is
  registered on the provider and is what the application sends. See
  [G5](#g5-authentik-uris).
- **Production upload cap.** 300 MB, set in the job draft. See
  [G7](#g7-upload-limits).

### G1. Deployment decisions

These are Friendy's to make as part of the deployment work. None is an
application decision, and nothing below can be finished without them.

| # | Decision | Why it blocks |
| --- | --- | --- |
| 1 | Rendering the Nomad variable field `keycloak_client_secret` as `AUTHENTIK_CLIENT_SECRET`, and setting `AUTHENTIK_ISSUER` and `AUTHENTIK_CLIENT_ID` instead of the `KEYCLOAK_*` names, in the deployed job | Sign-in fails with the old names. See [G4](#g4-environment-and-secrets). |
| 2 | Values or sources for `AUTH_SECRET`, MinIO and Qdrant | Authentication, uploads and status do not work without them. |
| 3 | Host port and network mode | The draft binds host port 3000 on `auraplex01`. See [G6](#g6-networking). |
| 4 | Image tag strategy and how the image reaches `auraplex01` | Decides what CI publishes. See [G3](#g3-what-ci-must-build-and-publish). |
| 5 | Staging identity: job, node, image | Only the staging hostname exists. See [G9](#g9-staging-checks). |
| 6 | Authentik provider settings: the `offline_access` scope mapping, an invalidation flow that ends the Authentik session, and `<AUTH_URL>/signed-out` as an allowed post-logout redirect | Without the first, nobody can sign in. See [Authentik provider](#authentik-provider). |

### G2. Building the image

From the repository root, with Docker available:

```bash
docker build -t auraplex.local/admin-upload:v1 .
```

- The build needs no secrets and no build arguments. Do not pass any secret
  as a build argument; every secret is read at runtime.
- The one optional build argument is `NEXT_PUBLIC_ADMIN_UPLOAD_MAX_MB`, a
  UI-only ceiling that is fixed into the image when it is built. Left out,
  the UI follows the server's runtime cap, which is 300 MB in production. If
  the production build passes it, the value must be `300`
  (`--build-arg NEXT_PUBLIC_ADMIN_UPLOAD_MAX_MB=300`); a lower value holds
  the UI below the server cap. See [G7](#g7-upload-limits).
- `.dockerignore` keeps local `.env` files out of the build context.
- The image runs as the unprivileged `node` user and listens on port 3000.

This build has **never been run**: Docker was not available where the
repository was prepared. Before the image is used, smoke-test the container:

```bash
docker run --rm -d --name admin-upload-smoke -p 3000:3000 auraplex.local/admin-upload:v1
curl -i http://localhost:3000/api/health     # 200 {"status":"ok","service":"auraplex-admin"}
docker exec admin-upload-smoke id -un         # node
docker rm -f admin-upload-smoke
```

The container starts and answers the health check with no environment
variables set. That confirms the image only; it says nothing about sign-in
or uploads.

### G3. What CI must build and publish

The repository has one workflow today, `.github/workflows/secrets-scan.yml`
(gitleaks). There is no workflow that tests or builds. CI needs to:

1. Use Node.js 22 and run `npm ci`.
2. Run `npm run typecheck`, `npm run lint` and `npm test`. `npm test` must
   end with no failed and no cancelled tests. The tests need no internet
   access, no production services and no real secrets. Some of them start
   local HTTP servers, so the runner must allow loopback (`localhost`)
   connections.
3. Run `npm run build`.
4. Build the image as in [G2](#g2-building-the-image) and run the container
   smoke test. For the production image, `NEXT_PUBLIC_ADMIN_UPLOAD_MAX_MB`
   must be either absent from the build or set to `300`; it must not be set
   to a lower value, in the build arguments or in the CI environment.
5. Publish the image under the name the job uses,
   `auraplex.local/admin-upload`, somewhere Docker on `auraplex01` can pull
   it from.

Open points for CI:

- **Where the image is published.** The job names `auraplex.local/admin-upload:v1`.
  Whether `auraplex.local` is a registry that CI can push to, or the image is
  built or loaded on the node, is not recorded in this repository.
- **Tag strategy.** Only `v1` has been confirmed. If a later build reuses the
  tag `v1`, Nomad's Docker driver does not pull it again by default, so the
  node can keep running the old image. Either publish a new tag per build and
  update the job, or decide how a reused tag is refreshed.
- CI must not run `nomad job run` against this draft.

### G4. Environment and secrets

Every variable the application reads. "Friendy" says whether a value must be
provided or configured for a deployment. No variable is checked at startup;
a missing one shows up when the feature that needs it is used.

| Variable | Purpose | Required | Default | Secret | Expected source | Friendy |
| --- | --- | --- | --- | --- | --- | --- |
| `AUTH_SECRET` | Encrypts the session cookie and the Proxy identity handoff | yes, for authentication | none | **yes** | runtime secret injection; store not specified | provide: a long random value, kept the same across restarts |
| `AUTH_URL` | Public origin of the application; used for the Authentik logout redirect | yes, in any deployed environment | none | no | job `env` (production value is in the draft) | set the staging value in the staging job |
| `AUTHENTIK_ISSUER` | Authentik provider issuer URL, trailing slash included | yes, for authentication | none | no | job `env` (in the draft) | nothing, unless staging differs |
| `AUTHENTIK_CLIENT_ID` | Authentik client ID | yes, for authentication | none | no | job `env` (in the draft) | nothing, unless staging differs |
| `AUTHENTIK_CLIENT_SECRET` | Secret of the confidential Authentik client | yes, for authentication | none | **yes** | Nomad variable `nomad/jobs/admin-upload`, field `keycloak_client_secret` | render the field under this name; see below |
| `AUTHENTIK_UPLOADER_GROUP` | Authentik group allowed to upload | no | `auraplex-uploader` | no | job `env`, only to override | nothing; the group exists |
| `AUTHENTIK_ADMIN_GROUP` | Authentik group allowed to administer and delete | no | `auraplex-admin` | no | job `env`, only to override | nothing; the group exists |
| `ADMIN_AUTH_DEBUG_CLAIMS` | `1` logs the structure of each validated ID token, for verifying the provider | no | unset (off) | no | job `env`, temporarily | set only while verifying AURA-INT-002, then remove |
| `MINIO_ENDPOINT` | MinIO S3 endpoint URL | yes, for upload and storage | none | no | job `env`; value not supplied | provide |
| `MINIO_ACCESS_KEY` | MinIO access key | yes, for upload and storage | none | **yes** | runtime secret injection; store not specified | provide |
| `MINIO_SECRET_KEY` | MinIO secret key | yes, for upload and storage | none | **yes** | runtime secret injection; store not specified | provide |
| `MINIO_REGION` | S3 region name sent to MinIO | no | `us-east-1` | no | job `env`, only to override | nothing, unless MinIO uses another region |
| `QDRANT_URL` | Qdrant endpoint, for processing status and delete | yes, for status and delete | none | no | job `env`; value not supplied | provide |
| `QDRANT_API_KEY` | Qdrant API key | only if Qdrant requires a key | none | **yes** | runtime secret injection; store not specified | provide if Qdrant requires one |
| `ADMIN_UPLOAD_MAX_MB` | Server-enforced per-file size cap, read at runtime | no | `100` (range 1–500) | no | job `env` (production value `300` is in the draft) | nothing for production; set it in the staging job |
| `ADMIN_UPLOAD_MAX_CONCURRENT` | Concurrent uploads per process | no | `4` (range 1–16) | no | job `env`, only to override | decide whether 4 fits in 512 MB |
| `ADMIN_TRUSTED_PROXY_SECRET` | Lets audit logging trust `cf-connecting-ip` | no; only with matching APISIX configuration | unset | **yes** | runtime secret injection, only if used | leave unset unless APISIX strips and injects the header |
| `NEXT_PUBLIC_ADMIN_UPLOAD_MAX_MB` | UI-only upload ceiling, fixed when the image is built | no | unset | no | Docker build argument | leave unset, or set `300` for the production build; never lower |
| `NODE_ENV` | Must be `production`: enables HTTPS-only cookies and logout | yes | `production` in the image | no | image and job `env` | nothing |
| `PORT` | Port the server listens on | yes | `3000` in the image | no | image and job `env` | nothing; see [G6](#g6-networking) |
| `HOSTNAME` | Address the server binds to | yes | `0.0.0.0` in the image | no | image and job `env` | nothing |

Secrets needing runtime injection: `AUTH_SECRET`, `AUTHENTIK_CLIENT_SECRET`,
`MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`, and `QDRANT_API_KEY` and
`ADMIN_TRUSTED_PROXY_SECRET` where they are used.

- The deployed job reads its secrets from the Nomad variable
  `nomad/jobs/admin-upload` (fields `auth_secret`, `keycloak_client_secret`,
  the MinIO fields and `qdrant_api_key`). That is a reference. No secret value
  has been read, and none is in this repository.
- The field `keycloak_client_secret` keeps its name. Since AURA-INT-002 it
  holds the Authentik client secret and must be rendered as
  `AUTHENTIK_CLIENT_SECRET`.
- This draft contains no template stanza; the deployed job's injection is
  Friendy's and is not copied here.
- `AUTH_SECRET` must not change between restarts or redeployments unless the
  intention is to sign everyone out: existing session cookies cannot be read
  with a different value.

### G5. Authentik URIs

The application sends:

| Environment | Redirect URI (callback) | Post-logout redirect URI |
| --- | --- | --- |
| Production | `https://admin-auraplex.auraplex.info/api/auth/callback/authentik` | `https://admin-auraplex.auraplex.info/signed-out` |
| Staging | `https://admin-auraplex-staging.auraplex.info/api/auth/callback/authentik` | `https://admin-auraplex-staging.auraplex.info/signed-out` |

The production redirect URI is registered on the provider. The post-logout
redirect must be accepted as well, and a staging environment needs both
registered for its own host. The comparison is in
[Authentik callback and logout URIs](#authentik-callback-and-logout-uris).

The provider must also issue refresh tokens (the `offline_access` scope
mapping), rotate them on every use, and put `groups` in the ID token; see
[Authentik provider](#authentik-provider).

### G6. Networking

Confirmed: the application listens on internal port 3000, and traffic arrives
through APISIX and the Cloudflare Tunnel. Everything else is open.

The draft uses host networking with a static port, so it binds **host port
3000 on `auraplex01`**. That is carried over from the reviewed template, not
confirmed. The public website has been documented as listening on host port
3000 with host networking. If it runs on `auraplex01`, the two jobs cannot
both hold the port.

The choices, none of which has been made:

- **Keep the draft**, after confirming that nothing else on `auraplex01` uses
  host port 3000.
- **Map a host port to internal port 3000**, with the host port static or
  dynamic. The application keeps listening on 3000. This is a change of
  network mode in the job, and APISIX then has to reach the mapped port, for
  example through the Consul service.

Whichever is chosen, the pieces have to agree:

- The Node.js server listens on the port given by `PORT`, which is `3000`.
- Changing only Nomad's static host port does not change the port the
  application listens on.
- A port reservation or mapping that does not lead to the port the
  application listens on can break service discovery, routing or the health
  check, even though the process itself is running.
- The network mode, the port block, `PORT`, and the service and check ports
  must therefore be changed together and kept consistent.

Also needed, and not in this repository: the APISIX route for each hostname
to the Admin service, and the Cloudflare Tunnel configuration. APISIX and
Cloudflare must pass request bodies up to the upload cap without buffering,
and must leave `/api/health` and `/signed-out` reachable without
authentication.

### G7. Upload limits

**The production upload cap is 300 MB**, confirmed by Friendy. 100 MB was
acceptable for testing and remains the application's fallback when nothing
is configured. The upload code is unchanged; only configuration differs.

Two settings are involved, and they are read at different times:

| | Server limit | Client (UI) ceiling |
| --- | --- | --- |
| Variable | `ADMIN_UPLOAD_MAX_MB` | `NEXT_PUBLIC_ADMIN_UPLOAD_MAX_MB` |
| Read | at **runtime**, on each request | at **build** time; fixed into the image |
| Set in | the Nomad job `env` | a Docker build argument, in CI |
| Enforces | yes: the server rejects larger files | no: it only limits what the UI offers |
| Unset | 100 MB (application fallback) | no ceiling; the UI follows the server limit |
| Production | `300`, set in `deploy/admin.nomad.hcl` | unset, or `300` |

The UI shows the lower of the two values. With the build-time ceiling unset,
the server passes its runtime limit to the page, so the UI shows 300 MB in
production with no rebuild and no build argument. The build-time value is
therefore not required. It only matters if it is set: a value below 300
would make the UI refuse files the server accepts, and a value above 300
changes nothing.

For production:

1. `ADMIN_UPLOAD_MAX_MB = "300"` is set in the job draft. Keep it.
2. Build the production image with `NEXT_PUBLIC_ADMIN_UPLOAD_MAX_MB` unset or
   set to `300`. Check that CI does not carry a lower value over from a test
   configuration.
3. Make APISIX, Cloudflare and anything else in the path allow request bodies
   of at least 300 MB. This has not been verified, and Cloudflare's limit
   depends on the plan; see the [runtime notes](AURA-INT-001-runtime.md).
4. Decide `ADMIN_UPLOAD_MAX_CONCURRENT`. The default of 4 was measured
   against a 1024 MB task; the job has 512 MB, and that combination has not
   been measured.

An environment that sets neither variable, such as a test deployment, gets
100 MB on both sides.

### G8. The Nomad job

The file to use is `deploy/admin.nomad.hcl`, **after** the items below are
done. It must not be submitted before then; see
[The Nomad job draft](#the-nomad-job-draft).

1. Add the runtime secret injection ([G4](#g4-environment-and-secrets)).
2. Add `MINIO_ENDPOINT` and `QDRANT_URL`. The 300 MB upload cap is already
   set; see [G7](#g7-upload-limits) for the concurrency setting.
3. Settle the network block ([G6](#g6-networking)).
4. Decide whether an update policy is needed so that an old and a new
   allocation cannot overlap. `count = 1` must stay; canary and scaling
   settings must not be added.
5. Run `nomad job validate` and `nomad job plan`. Neither has ever been run
   on this file.

Already in the file and confirmed: job `admin-upload`, group `web`, service
`admin-upload`, datacenter `acumen-local`, node `auraplex01`, image
`auraplex.local/admin-upload:v1`, CPU 500, memory 512 MB, one instance, the
300 MB upload cap, and the `GET /api/health` check.

The health check is liveness only. It passes with no secrets and with
Authentik, MinIO and Qdrant unreachable, so a healthy allocation is not proof
of a working deployment.

### G9. Staging checks

No staging environment is defined: there is no staging job, node or image,
only the hostname `admin-auraplex-staging.auraplex.info`. Staging needs its
own job with `AUTH_URL` set to `https://admin-auraplex-staging.auraplex.info`,
the Authentik provider set up for the staging host
([G5](#g5-authentik-uris)), and an explicit `ADMIN_UPLOAD_MAX_MB` if staging
is to be tested at the production cap of 300 MB.

Before production, on staging:

1. Run every check in [section F](#f-production-smoke-tests). They are
   written for the first deployment and apply to staging unchanged.
2. Pay particular attention to the checks that have only ever run against
   local fakes: sign-in and group checks against the real provider (4 to 7),
   logout through Authentik (8), an upload at the size cap through APISIX and
   Cloudflare (11), and the stored object and Qdrant status (14, 15).
3. Restart the allocation and repeat checks 1, 3 and 10 (check 19).
4. Update the job once and confirm that only one allocation serves traffic
   during the update.
