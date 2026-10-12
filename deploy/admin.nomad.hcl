# ─────────────────────────────────────────────────────────────────────────────
# Auraplex Admin — production Nomad job. DRAFT.
#
# NOT PRODUCTION-READY — DO NOT SUBMIT THIS FILE TO NOMAD.
# No `nomad job run`, and no `nomad job plan` against a real cluster with the
# intention of running it.
#
# This is a prohibition, not a technical lock. Nothing in this file stops
# Nomad: the HCL is meant to be well-formed, so Nomad may accept it and
# schedule the job. The missing secrets would not stop it either. The server
# process starts without them and GET /api/health answers 200, so the
# allocation can look healthy while sign-in and uploads cannot work.
#
# Deployment blockers (details in section E of
# docs/deployment/AURAPLEX-ADMIN-deployment.md). Friendy has confirmed that
# he handles this remaining infrastructure and deployment work; none of it
# needs a further application decision, and none of it is guessed here:
#
#   1. Runtime secret injection is not wired (see the TODO in the task
#      below). AUTHENTIK_CLIENT_SECRET, AUTH_SECRET and the MinIO and Qdrant
#      settings are absent.
#   2. The host port / network mapping is not confirmed (see the network
#      block). Only the internal application port, 3000, is.
#   3. The image has never been built or started: no Docker build and no
#      container smoke test have been run.
#   4. This file has never been validated. `nomad job validate` has not been
#      run on it (Nomad was not available where it was prepared) and it has
#      not been run anywhere.
#   5. The APISIX route and Cloudflare Tunnel configuration are not in this
#      repository. They must allow request bodies of at least the 300 MB
#      upload cap set below.
#
# Settled, and no longer blockers: the identity provider is Authentik
# (AURA-INT-002); its provider has the redirect URI
# <AUTH_URL>/api/auth/callback/authentik registered; and the production
# upload cap is 300 MB.
#
# What is confirmed and set below: job, group, service, internal port,
# datacenter, node, image, resources, single instance, health path, the
# production AUTH_URL, Authentik issuer and client ID, and the 300 MB upload
# cap. This is the production job only; no staging job exists.
#
# It deliberately does not reuse the public website's identity (its job,
# service or image names), so applying it can never replace that job. Do not
# put those names back.
# ─────────────────────────────────────────────────────────────────────────────
job "admin-upload" {
  datacenters = ["acumen-local"]
  type        = "service"

  constraint {
    attribute = "${node.unique.name}"
    value     = "auraplex01"
  }

  group "web" {
    # Single instance. Upload rate limiting, upload byte reservations, upload
    # concurrency, refresh/re-verification coordination, login ordering and
    # the Authentik metadata caches all live in the memory of one process and
    # are not shared. Do not raise this, and do not add canary or
    # multi-instance behaviour, until that is redesigned.
    #
    # count = 1 limits the steady state only. It does not by itself guarantee
    # that an old and a new allocation never overlap while the job is being
    # updated or rescheduled. No update policy is defined here.
    count = 1

    network {
      mode = "host"

      # TODO(unresolved): host port / network mapping. Confirmed: the
      # application listens on internal port 3000. NOT confirmed: that the
      # host port must be statically bound to 3000. Host networking and the
      # static port are carried over from the reviewed template, which makes
      # 3000 the host port on auraplex01 as well; the public website has been
      # documented as using that port. A dynamic host port mapped to internal
      # port 3000 would be equally consistent with what was confirmed.
      port "http" {
        static = 3000
      }
    }

    restart {
      attempts = 5
      interval = "5m"
      delay    = "15s"
      mode     = "delay"
    }

    task "next" {
      driver = "docker"

      config {
        image        = "auraplex.local/admin-upload:v1"
        network_mode = "host"
      }

      env {
        NODE_ENV = "production"
        PORT     = "3000"
        HOSTNAME = "0.0.0.0"

        # Confirmed, non-secret.
        AUTH_URL            = "https://admin-auraplex.auraplex.info"
        # The trailing slash is part of Authentik's issuer.
        AUTHENTIK_ISSUER    = "https://auth.auraplex.info/application/o/admin-upload-provider/"
        # The OAuth client ID is public (it is in every authorization URL);
        # gitleaks flags it only for its entropy.
        AUTHENTIK_CLIENT_ID = "2h09nO5KV46jz53vKyWxQzMJNv6Yxu0titxQFgXN" # gitleaks:allow

        # Upload size, confirmed: the production cap is 300 MB.
        # ADMIN_UPLOAD_MAX_MB is the server-enforced RUNTIME cap (range
        # 1-500; the application default, used when it is unset, is 100 MB)
        # and the admin UI follows it without a rebuild.
        # NEXT_PUBLIC_ADMIN_UPLOAD_MAX_MB is a separate BUILD-time, UI-only
        # ceiling inlined into the image; it cannot be set from this file.
        # The production image must be built with it unset or equal to 300:
        # a lower value would hold the UI below this cap.
        ADMIN_UPLOAD_MAX_MB = "300"

        # ADMIN_UPLOAD_MAX_CONCURRENT (default 4, range 1-16) caps concurrent
        # uploads PER ALLOCATION/PROCESS; it is not a cluster-wide limit. The
        # default was sized for a 1024 MB task, not the 512 MB below.
      }

      # TODO(unresolved): runtime secret injection.
      #
      # AUTHENTIK_CLIENT_SECRET must come from the Nomad variable
      #   nomad/jobs/admin-upload, field keycloak_client_secret
      # (the field keeps its Keycloak-era name; it holds the Authentik client
      # secret) and must never be written in this file. The deployed job
      # renders it, and that injection is Friendy's; it is not copied or
      # guessed here.
      #
      # The same mechanism must also provide the inputs whose source has not
      # been supplied: AUTH_SECRET, MINIO_ENDPOINT, MINIO_ACCESS_KEY,
      # MINIO_SECRET_KEY, QDRANT_URL and, if required, QDRANT_API_KEY.
      # See .env.example for the full list.

      resources {
        cpu    = 500
        memory = 512
      }
    }

    service {
      name     = "admin-upload"
      provider = "consul"
      port     = "http"

      check {
        name     = "healthz"
        type     = "http"
        # Liveness only: public, no session, and no call to Authentik, MinIO
        # or Qdrant. It proves the server process answers, not that those
        # services are reachable.
        path     = "/api/health"
        port     = "http"
        interval = "30s"
        timeout  = "5s"
      }
    }
  }
}
