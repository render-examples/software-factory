# Gateway Hardening Backlog

This document tracks remaining hardening items after the recent gateway security and logic fixes.

## 1) Enforce strict channel content type in production

- Current state: strict channel `Content-Type` validation is available, but opt-in via `RENDER_AGENTS_REQUIRE_CHANNEL_CONTENT_TYPE`.
- Hardening action: enable this env var in production deployments.
- Why: fail closed on malformed/non-standard ingress payloads for public `/channels/:id`.

## 2) Move input filtering/scoping into store queries

- Current state: input list/count endpoints still perform part of scoping in app-layer logic.
- Hardening action: add store-level query filters for ownership/thread/run scope and use them directly from gateway routes.
- Why: reduces broad scans, improves performance at scale, and narrows exposure of intermediate unscoped datasets.

## 3) Add endpoint rate limiting

- Current state: no explicit rate limiter on sensitive/public paths.
- Hardening action: add rate limiting (or WAF policy) for:
  - `/ui/login`
  - `/channels/:id`
  - OAuth entry paths (for example `/oauth/:provider/authorize`)
- Why: reduces brute force/abuse risk and limits resource exhaustion from high-frequency calls.

## 4) Apply consistent body-size limits on JSON endpoints

- Current state: channel ingress has explicit body caps; most other JSON routes do not.
- Hardening action: add shared body-size guard for thread, HITL, schedule, and other JSON POST/PATCH routes.
- Why: consistent DoS resistance and predictable request handling across the API surface.

## 5) Fail-fast production startup configuration checks

- Current state: some deployment-critical settings are warned at runtime instead of enforced.
- Hardening action: add a production startup validator for required auth/encryption settings (for selected deployment mode).
- Why: prevents insecure or partially configured production boots.
