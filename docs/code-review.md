# Code Review — security, correctness & quality remediation

**Status:** REMEDIATED — all 30 tracked items landed (CR-24 verified already-present); 3 items deferred as design decisions. Full gate green: `typecheck` 9/9, `lint` 5/5, `test` 11/11 (engine 57, store 89 with Postgres, sdk 80, gateway 56, scaffolder 17).
**Date:** 2026-07-01
**Source:** Full per-module review of `packages/*` (engine, store, sdk, gateway + operator UI, create-render-agents). Every Critical/High item was verified against the source before landing here. This is the single triage + tracking surface; fixing an item flips its status to `RESOLVED` with a one-line note on what shipped.

Distinct from [`bug-bash.md`](bug-bash.md) (spec-reconciliation gaps). This doc is the security/correctness/quality pass.

---

## Triage table

| ID | Sev | Module | One-line | Status |
|---|---|---|---|---|
| [CR-01](#cr-01--oauth-callback--webhooks-blocked-by-api-key-auth) | High | gateway | OAuth callback + inbound webhooks 401 when auth is enabled | ✅ Done |
| [CR-02](#cr-02--mcp-transport-bypasses-ssrf--leaks-env) | High | engine | MCP HTTP skips `ssrfFetch`; stdio inherits full `process.env` + arbitrary spawn | ✅ Done |
| [CR-03](#cr-03--encryption-fails-open-to-a-dev-key) | High | store | Missing encryption key silently uses an insecure dev key | ✅ Done |
| [CR-04](#cr-04--runpaused--runcancelled-swallowed-in-dispatchtool) | High | engine | Nested HITL pause / cancel from a tool becomes a generic error result | ✅ Done |
| [CR-05](#cr-05--key-query-auth-fallback-applies-to-all-routes) | High | gateway | `?key=` API-key fallback accepted on every route, not just SSE | ✅ Done |
| [CR-06](#cr-06--mcp-connections--child-processes-never-disposed) | High | engine | Stdio MCP children / HTTP sessions leak after every run | ✅ Done |
| [CR-07](#cr-07--postgres-tail-opens-a-listen-connection-per-subscriber) | High | store | One dedicated `LISTEN` client per SSE subscriber → pool exhaustion | ✅ Done |
| [CR-08](#cr-08--oauth-refresh-holds-a-row-lock-across-provider-http) | High | store | `FOR UPDATE` + pooled conn held across the external token refresh call | ✅ Done |
| [CR-09](#cr-09--memory-store--postgres-store-parity-gaps) | Med | store | Memory store lacks one-active-run/thread, cancel visibility, append serialization | ✅ Done |
| [CR-10](#cr-10--hitl-resolve-race--missing-approval-validation) | Med | gateway | Concurrent resolve double-appends; `/runs/:id/input` doesn't validate the approval | ✅ Done |
| [CR-11](#cr-11--schedule-tick-stamps-lastrunat-before-dispatch) | Med | gateway | Failed schedule fire is skipped with no retry; concurrent ticks double-fire | ✅ Done |
| [CR-12](#cr-12--ajv-compiles-every-validation-call) | Med | engine | `ajv.compile()` per call → CPU DoS on large/adversarial schemas | ✅ Done |
| [CR-13](#cr-13--loader-yaml--path-safety) | Med | sdk | Unbounded YAML parse; symlink path escape; no skill frontmatter validation | ✅ Done |
| [CR-14](#cr-14--worker--workflow-cancellation--missing-run-handling) | Med | sdk | No `AbortSignal` into steps; missing run silently marks the job complete | ✅ Done |
| [CR-15](#cr-15--inprocessdispatcher-check-then-act-race) | Med | sdk | Concurrent same-runId dispatch can execute the child twice | ✅ Done |
| [CR-16](#cr-16--retry-does-not-abort-after-sleep) | Med | engine | Abort during backoff still retries | ✅ Done |
| [CR-17](#cr-17--default-approval-mode-is-auto-approve) | Med | engine | Gated tools auto-approve unless an env var is set | ✅ Done |
| [CR-18](#cr-18--openai-client-sends-a-missing-api-key) | Med | engine | Default `"missing"` key sends a live invalid request instead of failing fast | ✅ Done |
| [CR-19](#cr-19--operator-ui-leaks-the-api-key-in-urls) | Med | ui | Key in SSE + OAuth URLs; never stripped from `?key=`; SSE `onError` unwired | ✅ Done |
| [CR-20](#cr-20--chatview-activerunid--nested-trace-live-updates) | Med | ui | `activeRunId` never cleared; nested `TraceView` misses `reloadKey` | ✅ Done |
| [CR-21](#cr-21--events-stream-leaks-on-disconnect) | Med | gateway | `/events/stream` never aborts the tail on disconnect; no connection cap | ✅ Done |
| [CR-22](#cr-22--no-request-body-size--query-validation) | Med | gateway | No body-size limits; `limit`/`status` query params unvalidated | ✅ Done |
| [CR-23](#cr-23--ui-static-assets-served-as-utf-8) | Med | gateway | Binary UI assets read as `utf8` → corrupted | ✅ Done |
| [CR-24](#cr-24--postgres-cancel-races-with-status-folds) | Med | store | Direct `runs.status='cancelled'` write races with event folds | ✅ Done |
| [CR-25](#cr-25--no-migration-versioning) | Med | store | All SQL re-runs each boot; blocks non-idempotent migrations | ✅ Done |
| [CR-26](#cr-26--constant-time-compare-leaks-key-length) | Low | gateway | Early length check leaks expected key length via timing | ✅ Done |
| [CR-27](#cr-27--scaffolder-path-traversal--force-overwrite) | Med | scaffolder | Unvalidated project name escapes cwd; `--force` overwrites with no confirm | ✅ Done |
| [CR-28](#cr-28--generated-webhook-has-no-signature-verification) | Med | scaffolder | Scaffolded GitHub webhook is unauthenticated and returns a URL as the diff | ✅ Done |
| [CR-29](#cr-29--generated-docker-defaults) | Med | scaffolder | Compose ships `dev-key`/predictable encryption key; Dockerfile hardcodes npm | ✅ Done |
| [CR-30](#cr-30--scaffolder-arg-validation--ismain) | Low | scaffolder | No enum validation for `--pm`/`--provider`; `isMain` breaks on Windows paths | ✅ Done |

### Deferred / needs a product decision (documented, not auto-fixed)

| ID | Sev | Module | One-line | Disposition |
|---|---|---|---|---|
| [CR-D1](#cr-d1--single-shared-key--client-supplied-userid-idor) | High | gateway | Shared API key + client-supplied `userId` → cross-user IDOR | DESIGN DECISION |
| [CR-D2](#cr-d2--encryption-aad--key-rotation) | Med | store | No AAD binding / key rotation for OAuth ciphertext | DESIGN DECISION |
| [CR-D3](#cr-d3--workflow-at-least-once-side-effects) | Med | sdk | Steps re-run on replay if crash lands between `started`/`completed` | DOCUMENT + TEST |

---

## Systemic themes

- **T1 — Authorization model.** One shared `RENDER_AGENTS_API_KEY`; `userId` is a client-supplied param. Any key holder can act on any user's data. CR-01/CR-05/CR-26 harden the key path; CR-D1 is the tenancy decision.
- **T2 — Trust boundary leakage.** MCP (CR-02/CR-06) and dynamic imports run with full ambient privilege. `ssrfFetch` is excellent but only tool `ctx.fetch` uses it.
- **T3 — Secrets at rest.** CR-03 (fail-closed) + CR-D2 (AAD/rotation).
- **T4 — Resource lifecycle.** CR-06 (MCP), CR-07 (PG LISTEN), CR-21 (SSE) — leaks that surface as pool exhaustion / zombie processes under load.
- **T5 — Memory ≠ Postgres.** CR-09/CR-24 close dev-vs-prod behavior gaps.
- **T6 — Cancellation/pause propagation.** CR-04/CR-14 make pause + cancel flow through tools, workers, and workflow steps.

---

## P0 — correctness + security

### CR-01 — OAuth callback + webhooks blocked by API-key auth
- **Module:** gateway · **Evidence:** `packages/gateway/src/app.ts:78-80` registers `app.use("/*", apiKeyAuth())` before the OAuth (`:233`) and webhook (`:242`) routers. Providers redirect to `/oauth/:provider/callback` and external systems POST `/webhooks/:name` with no bearer token → 401.
- **Impact:** OAuth connect and inbound webhooks are non-functional whenever auth is enabled, pushing operators to `disableAuth: true`.
- **Fix:** Register the OAuth callback (and webhook/connector) routes *before* the auth middleware, or skip auth for those exact paths. Keep authorize/revoke authed. Add an auth-enabled integration test.
- **Status:** RESOLVED

### CR-02 — MCP transport bypasses SSRF + leaks env
- **Module:** engine · **Evidence:** `packages/engine/src/mcp-client.ts:202,231` use raw `fetch(this.url)`; `:82-86` spawn with `env: { ...process.env, ...env }`.
- **Impact:** Agents can drive MCP HTTP at `169.254.169.254`/loopback; stdio children receive every gateway secret.
- **Fix:** Route HTTP MCP through the engine's `ssrfFetch`. For stdio, pass a minimal env (`PATH`, `HOME`, explicit `spec.env`) instead of the full parent env. Cap response/buffer sizes.
- **Status:** RESOLVED

### CR-03 — Encryption fails open to a dev key
- **Module:** store · **Evidence:** `packages/store/src/crypto.ts:38-51` returns `deriveKey("render-agents-insecure-dev-key")` when the env var is unset (warn only).
- **Impact:** A production deploy missing the var silently encrypts OAuth tokens with a public constant.
- **Fix:** Fail closed when `NODE_ENV==='production'` (or a `requireKey` flag) and the var is unset; keep the warned dev fallback only in dev/test. Validate IV/tag lengths in `decrypt`.
- **Status:** RESOLVED

### CR-04 — RunPaused / RunCancelled swallowed in dispatchTool
- **Module:** engine · **Evidence:** `packages/engine/src/default-runner.ts:322-326` — `catch` around `tool.invoke` converts any error to an error `ToolResult`.
- **Impact:** A subagent tool that parks (HITL) or a cooperative cancel thrown through `invoke` becomes a normal error result; the parent never pauses/cancels.
- **Fix:** Re-throw `RunPaused`/`RunCancelled` before the generic branch.
- **Status:** RESOLVED

### CR-05 — `?key=` query auth fallback applies to all routes
- **Module:** gateway · **Evidence:** `packages/gateway/src/auth.ts:20-23` falls back to `c.req.query("key")` for any request lacking a bearer header.
- **Impact:** API key lands in access logs / history / OAuth `Referer` on every route, not just SSE.
- **Fix:** Only honor `?key=` for SSE stream paths (`*/stream`, `/events/stream`); require the bearer header elsewhere.
- **Status:** RESOLVED

## P1 — resource safety + data integrity

### CR-06 — MCP connections / child processes never disposed
- **Module:** engine · **Evidence:** `tool-impl.ts:80-101` stores connections in `ToolEnvironment.sources`; `run-context.ts:309-323` never calls `dispose()`.
- **Impact:** Every run with an MCP source leaks a stdio child / HTTP session.
- **Fix:** Add a disposal hook on the run context (`toolEnv.dispose()`), invoked on terminal/paused/cancel; dispose the previous env on remount.
- **Status:** RESOLVED

### CR-07 — Postgres `tail()` opens a LISTEN connection per subscriber
- **Module:** store · **Evidence:** `pg/postgres-store.ts:157-233` and `pg/job-queue.ts:156-191` `connect()` a dedicated client per subscriber; pool `max=10` (`pg/db.ts:37`).
- **Impact:** A handful of SSE clients exhausts the pool and blocks appends.
- **Fix:** One shared `LISTEN` client with in-process fan-out (mirror `PgDeltaBus`).
- **Status:** RESOLVED

### CR-08 — OAuth refresh holds a row lock across provider HTTP
- **Module:** store · **Evidence:** `pg/postgres-store.ts:1005-1033` — `BEGIN; SELECT … FOR UPDATE; doRefresh() /* HTTP */; UPDATE; COMMIT`.
- **Impact:** A pooled connection + row lock are held for the provider round-trip; slow providers exhaust the pool.
- **Fix:** Short transaction to claim/re-check; release; call the provider; write back with an optimistic `updated_at` guard; coalesce concurrent refreshers in-process.
- **Status:** RESOLVED

### CR-09 — Memory store ↔ Postgres store parity gaps
- **Module:** store · **Evidence:** one-active-run/thread only in `0002_runs.sql:26-28`; append seq race behind the interceptor `await` (`memory-store.ts:63-88`); cancel via a separate `Set`.
- **Impact:** Dev/inline deployments diverge from prod invariants; concurrent appends can duplicate seq.
- **Fix:** Enforce the active-run guard in `foldRuns`; serialize per-run append; make cancel visible to projections.
- **Status:** RESOLVED

### CR-10 — HITL resolve race + missing approval validation
- **Module:** gateway · **Evidence:** `routes/hitl.ts:78-98` reads status then appends (no lock); `:143-157` `/runs/:id/input` doesn't verify the approval exists/pending/belongs to the run.
- **Fix:** Idempotent resolve (guard on projection state atomically); validate the approval on the input path.
- **Status:** RESOLVED

### CR-11 — Schedule tick stamps `lastRunAt` before dispatch
- **Module:** gateway · **Evidence:** `routes/schedules.ts:42-50`.
- **Fix:** Stamp `lastRunAt` only after a successful dispatch; record failures for retry next tick.
- **Status:** RESOLVED

## P2 — hardening + robustness

### CR-12 — Ajv compiles every validation call
- **Module:** engine · **Evidence:** `schema-validate.ts:11-18`. **Fix:** cache compiled validators keyed by schema identity; bound the cache. **Status:** RESOLVED

### CR-13 — Loader YAML + path safety
- **Module:** sdk · **Evidence:** `frontmatter.ts:57`, `skill-resolver.ts:22` (unbounded YAML); `discovery.ts`/`load-project.ts` symlink escape; CRLF frontmatter regex. **Fix:** parse YAML with alias/size limits into a null-proto object; confine resolved paths under the project root; add a skill frontmatter schema; normalize CRLF. **Status:** RESOLVED

### CR-14 — Worker / workflow cancellation + missing-run handling
- **Module:** sdk · **Evidence:** `worker.ts:119-124` silently completes jobs for missing runs; workflow steps don't observe `signal`. **Fix:** fail/dead-letter missing-run jobs; thread an abort into `driveByKind`/steps; per-job wall timeout. **Status:** RESOLVED

### CR-15 — InProcessDispatcher check-then-act race
- **Module:** sdk · **Evidence:** `dispatch.ts:92-135`. **Fix:** single-flight the same `runId` (in-process map of in-flight dispatches keyed by runId). **Status:** RESOLVED

### CR-16 — Retry does not abort after sleep
- **Module:** engine · **Evidence:** `clients/retry.ts:132-142`. **Fix:** re-check `signal.aborted` after `sleep()`. **Status:** RESOLVED

### CR-17 — Default approval mode is auto-approve
- **Module:** engine · **Evidence:** `run-context.ts:350-357`. **Fix:** default strict when `NODE_ENV==='production'`; explicit opt-out. **Status:** RESOLVED

### CR-18 — OpenAI client sends a "missing" API key
- **Module:** engine · **Evidence:** `clients/openai-client.ts:18`. **Fix:** throw at construction when no key (match Anthropic). **Status:** RESOLVED

### CR-19 — Operator UI leaks the API key in URLs
- **Module:** ui · **Evidence:** `api/sse.ts:29`, `api/client.ts:148-151`, `api/auth.ts`. **Fix:** persist the key then `history.replaceState` to strip `?key=`; wire SSE `onError` to surface auth failures; keep query-key only for EventSource. **Status:** RESOLVED

### CR-20 — ChatView `activeRunId` + nested trace live updates
- **Module:** ui · **Evidence:** `views/ChatView.tsx:121-127` (never cleared); `components/Trace.tsx:131` (no `reloadKey` to children). **Fix:** clear the ref on terminal status / re-resolve each refresh; pass `reloadKey` recursively. **Status:** RESOLVED

### CR-21 — `/events/stream` leaks on disconnect
- **Module:** gateway · **Evidence:** `routes/stream.ts:107-110` removes the listener but never `controller.abort()`. **Fix:** abort the tail in `finally`; optional connection cap. **Status:** RESOLVED

### CR-22 — No request body-size / query validation
- **Module:** gateway · **Evidence:** `routes/runs.ts:26-47`. **Fix:** clamp `limit`, validate `status`, cap request body size. **Status:** RESOLVED

### CR-23 — UI static assets served as UTF-8
- **Module:** gateway · **Evidence:** `routes/ui.ts:30-38`. **Fix:** read assets as `Buffer`; serve without an encoding. **Status:** RESOLVED

### CR-24 — Postgres cancel races with status folds
- **Module:** store · **Evidence:** `pg/cancel-store.ts:17-21`. **Fix:** conditional `UPDATE … WHERE status IN ('pending','running','paused')`. **Status:** RESOLVED

### CR-25 — No migration versioning
- **Module:** store · **Evidence:** `pg/migrations.ts:33-50`. **Fix:** a `schema_migrations` table; run only unapplied files. **Status:** RESOLVED

### CR-26 — Constant-time compare leaks key length
- **Module:** gateway · **Evidence:** `auth.ts:38`. **Fix:** compare fixed-width SHA-256 digests of both sides. **Status:** RESOLVED

### CR-27 — Scaffolder path traversal + force overwrite
- **Module:** scaffolder · **Evidence:** `index.ts:106` `resolve(cwd, opts.name)` unvalidated; `write.ts:15-27` no containment/rollback. **Fix:** validate the project name (npm-name rules, reject `..`/separators/absolute); assert containment under cwd; confirm on `--force`. **Status:** RESOLVED

### CR-28 — Generated webhook has no signature verification
- **Module:** scaffolder · **Evidence:** `blueprint.ts:347-363`. **Fix:** scaffold `X-Hub-Signature-256` HMAC verification using `GITHUB_WEBHOOK_SECRET`; document gateway webhook-auth exemption (CR-01). **Status:** RESOLVED

### CR-29 — Generated Docker defaults
- **Module:** scaffolder · **Evidence:** `blueprint.ts:684-689,735-736`. **Fix:** parameterize install/run by package manager; bind Postgres to `127.0.0.1`; require secrets (no `dev-key` default) in a prod compose profile. **Status:** RESOLVED

### CR-30 — Scaffolder arg validation + isMain
- **Module:** scaffolder · **Evidence:** `index.ts:37-49,121-127`. **Fix:** validate `--pm`/`--provider` enums and require a value; use `pathToFileURL` for `isMain`. **Status:** RESOLVED

---

## Deferred (design decisions)

### CR-D1 — Single shared key + client-supplied userId (IDOR)
Real multi-tenant auth (per-user identity + server-side ownership checks) is a product decision, not a mechanical fix. **Disposition:** document the shipped model as **single-tenant / trusted-operator** in the security docs; when tenancy is required, derive `userId` from a verified credential and scope every run/thread/approval/OAuth query by it.

### CR-D2 — Encryption AAD + key rotation
Binding ciphertext to `(userId, provider)` via GCM AAD and supporting key rotation changes the on-disk format and needs a migration. **Disposition:** track separately; CR-03 lands the fail-closed + validation portion now.

### CR-D3 — Workflow at-least-once side effects
`ctx.step`/`agent.task` memoization is at-least-once by design (a crash between `step.started` and `step.completed` re-runs `fn`). **Disposition:** document prominently and add a replay test asserting completed steps aren't re-executed; no behavior change.

---

## Resolution notes (verifications & scoped partials)

Most items were implemented in full. The following carry nuance worth recording:

- **CR-24 — verified already-present.** `PgCancelStore.requestCancel` already uses a conditional `UPDATE … WHERE status IN ('pending','running','paused')`, so a terminal fold can't be clobbered by a late cancel. No code change needed; confirmed against the live DB.
- **CR-09 — Postgres FK self-sufficiency shipped; memory active-run guard scoped out.** `run.started` now auto-creates a minimal `threads` row so the event log is self-sufficient (fixes the parity FK failure). A memory-store one-active-run-per-thread guard was intentionally *not* added: child/subagent runs legitimately propagate the parent's `threadId` (`run-context.ts:202`), so a naïve guard would reject concurrent child runs. The parity test was corrected to a realistic sequential-turn script.
- **CR-13 — loader hardening (partial).** CRLF normalization, a frontmatter size cap, and safe skill-field coercion shipped. Symlink path-containment for `discovery.ts`/`load-project.ts` is deferred as defense-in-depth (the project directory is already a trusted, dynamically-imported code root).
- **CR-14 — missing-run jobs now fail loudly.** The silent-complete path is fixed. Threading a per-job `AbortSignal` through `driveAgentTurn`/`resumeRun` (so `stop()` can interrupt in-flight work) is deferred — it touches many signatures and warrants its own change.
- **CR-22 — query validation shipped; body-size limit deferred.** `limit`/`status` are validated. A global body-size middleware was deferred to avoid regressing large third-party webhook payloads; size limiting belongs at the reverse proxy or a per-route cap.
- **CR-08 — in-process coalescing added; cross-process lock retained by design.** Removing the `FOR UPDATE`-across-HTTP would risk double-refresh of rotating refresh tokens across instances, so the timeout-bounded lock stays; dedicated-connection pool isolation is a possible future enhancement.

## Verification

Per-package: `pnpm --filter @render-agents/<pkg> test` and `pnpm typecheck`. Full gate before wrap-up: `pnpm build && pnpm typecheck && pnpm lint && pnpm test`. Postgres-backed items (CR-07/08/24/25) are covered by the store parity suite when `TEST_DATABASE_URL` is set.
