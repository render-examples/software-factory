#1 — Make multi-tenancy a real default
What already exists (packages/gateway/src/auth.ts): a Principal { userId, role }, a pluggable AuthResolver (apiKeyAuth({ resolver })), and canAccess(ownerUserId, principal). The code even comments that "plugging in a real per-user resolver later yields true multi-tenancy without touching the routes." The only reason it's operator-centric today is the default resolver (bearerKeyResolver) maps the one shared key → a single operator principal, and canAccess returns true for operators.

What it would require:

A built-in per-user resolver. Ship a JWT/OIDC verifier (JWKS fetch+cache, verify iss/aud/exp/sig via jose, map a configurable claim → userId, return role: "user"), and/or per-tenant API keys (hashed, in a table). Wire it through the existing resolver option — zero route changes.
An end-to-end scoping audit + default-deny. Confirm every by-id/list route (runs, threads, approvals, schedules, connections, and the /runs/:id/stream, /threads/:id/stream SSE routes) actually calls canAccess/filters on principal.userId and never trusts a client-supplied id. Add tests proving tenant A can't read, stream, or resolve tenant B's resources. (The store already carries userId; this is verification + closing gaps.)
Fix the ?key= SSE fallback for per-user mode. Today ?key= grants the operator key (fine for the console, unsafe for per-user streams). A multi-tenant deployment needs a short-lived signed per-user stream token or a userId-scoped cookie session.
Isolate the shared infra. The warm chat worker + run_jobs queue are shared, so add per-userId concurrency limits / quotas / priority in the queue claim (noisy-neighbor protection) and per-tenant budget caps. (OAuth tokens are already per-user + encrypted, so secret isolation is done.)
Effort: moderate. The auth seam and userId plumbing exist; the work is the JWT/OIDC resolver + the authz audit/tests + queue fairness.

---

## Implementation status

**Security core: DONE.** Per-user multi-tenancy is now a safe default.

- **Built-in JWT/OIDC resolver.** `jwtAuthResolver({ issuer, audience, jwksUri, userIdClaim?, roleFrom? })` (`packages/gateway/src/jwt-auth.ts`, jose) verifies a bearer JWT against an IdP JWKS and maps a claim to `userId` (`role: "user"` by default; fail-closed). `composeResolvers(...)` layers per-user JWT with a shared-key operator break-glass. Wires through the existing `createGatewayApp({ auth })` — zero route changes.
- **Authz-gap closure (mechanism-independent).**
  - Schedules are now tenant-owned: `schedules.userId` (migration `0011`, memory + pg + parity), stamped from auth on create, `canAccess`/`userId`-filtered across CRUD, and cron-fired runs inherit the owner.
  - `/admin/*` is operator-only via a `requireOperator()` middleware (retention, run reaper, queue depth, schedule tick) — `403` for `role: "user"`.
  - `/threads/:id/stream` no longer bypasses ownership when a thread has no metadata row (non-operators are denied).
- **Per-user SSE.** `POST /auth/stream-token` issues a short-lived signed token bound to the principal; the auth middleware accepts it via `?token=` on SSE paths (`packages/gateway/src/stream-token.ts`). `?key=` stays operator-only.
- **Tests.** JWT resolver unit, stream-token unit, and cross-tenant denial tests (runs/threads already covered; added schedules, `/admin/*` 403, thread-SSE, stream-token) + memory/pg schedule parity. Full suite green incl. Postgres.

**Deferred to follow-up (shared-infra isolation):**
- Per-userId queue concurrency/quota in `claim` — jobs carry no `userId` today; needs a `run_jobs.user_id` column + a capped claim query + the memory-queue twin.
- Per-tenant budget caps — per-run `total_cost_usd` exists; needs a tenant rollup + an enqueue/claim spend gate.

Not a data-isolation hole (noisy-neighbor / cost governance), so it is sequenced after the security core.