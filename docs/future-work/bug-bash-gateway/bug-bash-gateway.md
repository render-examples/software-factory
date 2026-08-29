# Gateway Package Audit — Bug Bash 8/30

Audit of `packages/gateway/` (17 server files, 35 operator-UI files, 12 test files).

## Executive Summary

1. **Several security defaults depend on `NODE_ENV === "production"`, but this
   repository does not set `NODE_ENV`.** Missing webhook verification is allowed,
   UI cookies omit `Secure`, and OAuth encryption/state signing use a public
   development key.
2. **Critical state transitions are check-then-write races.** Two approval
   requests can record contradictory decisions, concurrent schedule ticks can
   dispatch twice, and inbound webhook retries can start duplicate work.
3. **The authenticated-user boundary is broader than the authorization
   boundary.** Any authenticated user can dispatch or schedule every registered
   workflow, while the policy subsystem that should narrow tool privileges is
   not currently wired.
4. **SSE replay is not gap-free.** Snapshot-then-subscribe windows can lose
   events, and single-run `Last-Event-ID` resumes inclusively, duplicating the
   last frame.
5. **Input and resource limits are inconsistent.** Channel bodies are capped,
   but login and most JSON API routes, SSE connections, event scans, and
   workflow dispatches have no gateway-wide size/rate limits.
6. **The latest Postgres schema is incompatible with gateway chat.** Migration
   0017 drops `messages`, but event projection and thread reads still query it.
7. **Stream-token serialization permits role escalation.** A crafted but valid
   user ID shifts delimiter-separated fields and verifies as an operator token.

### Verification

- `pnpm --filter @render-factory/gateway test`: **98 passed, 1 skipped**
- `pnpm --filter @render-factory/gateway build`: **passed**
- UI-only TypeScript check: **passed**
- Package `typecheck`: **fails with three existing test type errors**
- Package `lint`: **fails** at `routes/ui.ts:62` (`no-empty`)

---

## Bugs

### 1. `/runs/counts` loads all runs into memory to count them

**Priority:** High
**File:** `routes/runs.ts:117–137`

Six separate `store.listRuns()` calls fetch every run record per status, then
take `.length`. This materializes all runs just to count them. A single
`COUNT(*) … GROUP BY status` query (or a dedicated `store.countRuns()` method)
would cut memory and latency by orders of magnitude.

### 2. `getPrincipal` falls back to operator on missing auth

**Priority:** High
**File:** `auth.ts:146`

```ts
export function getPrincipal(c: Context): Principal {
  return c.get("principal") ?? { userId: DEFAULT_OPERATOR_ID, role: "operator" };
}
```

If the auth middleware fails to set a principal (middleware ordering bug,
uncaught error, or a route registered before the middleware), the fallback
silently grants **operator** access — the highest privilege level. This should
either throw or return a restrictive `role: "user"` with a sentinel userId.

The normal `createGatewayApp` ordering currently sets a principal before
protected routes, so this is primarily a dangerous exported-route/composition
default rather than a demonstrated bypass in the standard app.

### 3. `JSON.stringify` on channel input can throw on circular references

**Priority:** Medium
**File:** `app.ts:328`

```ts
const text = typeof input === "string" ? input : (JSON.stringify(input) ?? "");
```

`input` comes from `channel.parse()`, which is third-party-authored code. If it
returns an object with circular references, `JSON.stringify` throws an unhandled
`TypeError`, crashing the handler.

---

## Security Issues

### 4. Stream token and OAuth state share the same HMAC secret without domain separation

**Priority:** Medium
**Files:** `stream-token.ts`, `routes/oauth.ts`

Both subsystems use HMAC-SHA256 over the same secret (the cookie/encryption
key), but neither includes a purpose prefix in the signed payload. A
purpose-binding prefix (e.g. `"stream:"` or `"oauth:"` prepended before HMAC)
is standard practice to prevent cross-purpose forgery.

### 5. OAuth `exchangeCode` and `buildRefresher` have no SSRF guard

**Priority:** High
**File:** `routes/oauth.ts:159–178, 133–156`

Token endpoint URLs are operator-configured strings. The HTTP calls use the
global `fetch` without SSRF protection. A misconfigured or compromised
`tokenUrl` pointing to an internal address (e.g. cloud metadata at
`169.254.169.254`) would be followed without validation. The engine provides
`ssrfFetch` / `assertUrlAllowed` for this purpose.

### 6. Ephemeral cookie secret silently accepted in production

**Priority:** High
**File:** `ui-session.ts:117–126`

No mechanism prevents production deployments from running without
`RENDER_FACTORY_COOKIE_SECRET`. The gateway silently generates a random
per-process secret and sessions break on restart. Should refuse to start in
production without an explicit secret.

---

## Confirmed Security & Correctness Findings

### 7. Runtime security posture depends on an unset `NODE_ENV`

**Priority:** High
**Files:** `verify.ts:176–218`, `ui-session.ts:39–50`, `app.ts:80–95`,
`packages/store/src/crypto.ts:40–63`

Three independent safety decisions use `NODE_ENV === "production"`:

- a channel with no `verify` is accepted and only logs a warning;
- the UI session cookie omits `Secure`;
- OAuth tokens and state signatures use the public
  `render-factory-insecure-dev-key`.

The repository does not set `NODE_ENV`. A focused probe confirmed all three
development behaviors with repository defaults.

Make safe behavior the default. Require an explicit development opt-out for
unsigned channels and insecure keys, default cookies to `Secure`, and fail
startup when OAuth is configured without an encryption key.

### 8. The long-lived operator key is accepted in URLs

**Priority:** High
**File:** `auth.ts:77–89, 185–194`

Any allowlisted stream path and OAuth authorize navigation may authenticate with
`?key=<shared operator key>`. That key can enter reverse-proxy/access logs,
monitoring traces, copied URLs, and browser history. The matcher also allows any
future path ending in `/stream`.

The gateway now has safer alternatives: session cookies for the UI and
short-lived stream tokens for EventSource.

Remove the shared-key query fallback by default.

### 9. OAuth state is signed but not bound to the initiating browser session

**Priority:** High in multi-user deployments
**File:** `routes/oauth.ts:43–102, 187–220`

The state contains a signed `userId`, nonce, and timestamp, but the nonce is not
stored or consumed and the public callback does not verify that the current
browser session matches the state owner.

An authenticated attacker can start a connection for their gateway identity and
send the provider authorization URL to a victim. If the victim authorizes their
external account, the callback stores the victim's provider token under the
attacker's signed gateway `userId` — an account-linking/login-CSRF attack. The
same state can be reused with fresh provider codes during its ten-minute window.

Store a one-time state record bound to the initiating session, consume it
atomically on callback, require the callback session to match, and use PKCE.

### 10. Authenticated users can dispatch and schedule every workflow

**Priority:** High
**Files:** `routes/runs.ts:51–71`, `routes/schedules.ts:80–111`

Tenant checks limit which records a user can read, but no authorization check
limits which workflow names they may invoke. Any authenticated user can dispatch
or create a recurring schedule for any registered workflow. This is especially
risky while engine policy/credential routing is not wired: a user-owned run may
reach tools backed by shared service credentials.

Add a workflow authorization callback or scopes/roles to the principal, and
add per-user cost/concurrency quotas.

### 11. Input resolution is a contradictory-decision race

**Priority:** Critical
**Files:** `routes/hitl.ts:171–222, 228–294`,
`routes/threads.ts:177–208`

Resolution checks `target.status === "pending"` and appends `input.provided` as
separate operations. Two requests can both observe pending and append different
decisions, then both trigger resume.

Reproduced: concurrent approve and deny requests both returned 200 and the log
contained `[true, false]`. The final projection depends on event order, while a
resumed tool may already have acted on the earlier approval.

The route also does not require the owner run to be paused. A decision can be
accepted between `input.requested` and `run.paused`, causing resume to run too
early before the run later settles as paused. Inputs belonging to terminal runs
are also accepted; resume errors are swallowed after the 200 response.

Add an atomic store operation that transitions one input from pending to a
single immutable resolution only when its run is in a resumable state. Return a
conflict to losers and terminal runs, or enqueue a durable resume command that
waits for the paused transition.

### 12. Schedule firing has duplicate and lost-dispatch windows

**Priority:** High
**File:** `routes/schedules.ts:25–60`

`reconcileDueSchedules` reads due schedules and later updates `lastRunAt`;
there is no conditional claim. Two concurrent ticks can both read the same due
row and both dispatch.

Reproduced: two reconciles in the same minute each reported one fire.

Atomically claim `(scheduleId, dueMinute)` with a unique constraint, derive a
deterministic run/idempotency key, and dispatch through a durable outbox.

### 13. Channel delivery replay protection is not wired into the gateway

**Priority:** High
**Files:** `routes/channels.ts:119–228`, `app.ts:411–418`,
`inbound-worker.ts`

`channelRoutes` has an optional persist-then-ack `InboundStore` path, but
`GatewayOptions` does not expose it, `createGatewayApp` never passes it, and no
normal composition starts `InboundWorker`. Workflow-target channels have no
deduplication at all.

Reproduced: two identical signed deliveries became two workflow dispatches.

Require a provider delivery/event ID in the `Channel` contract, persist every
accepted delivery with a scoped uniqueness window, and wire the inbound store
and worker in the composition root.

### 14. Gateway-wide body, rate, and connection limits are missing

**Priority:** High
**Files:** `ui-session.ts:98–109`, `routes/runs.ts:51–71`,
`routes/threads.ts:60–90, 147–168`, `routes/hitl.ts:171–179`,
`routes/schedules.ts:80–111`, `routes/stream.ts`

Channel requests have a one-megabyte streamed cap, but other JSON routes call
`c.req.json()` without a body limit. The public login route is enough for an
unauthenticated large-body memory attack; authenticated workflow inputs,
metadata, and HITL values can also inflate storage/model context.

No request rate limit, login throttle, per-user workflow quota, or SSE
connection cap. Add global request-size and deadline middleware, rate limits,
per-principal dispatch budgets, and bounded SSE connections.

### 15. Nested child HITL resume can strand or misroute the parent

**Priority:** High
**File:** `app.ts:196–237`

`findPausedWorkflowRoot` walks `parentSpanId` by calling `store.getRun()` as if
every parent span ID were a run ID. Nested agent/subagent children point to
agent/tool span IDs. The walk stops before finding the paused workflow root.

The fallback dispatches `"chat-turn"` for any unresolved child when that
workflow exists, even if the child belongs to a different workflow.

Persist an explicit `parentRunId` on every run and traverse run ancestry, never
span IDs.

### 16. Interactive run initialization can leave stranded partial runs

**Priority:** High
**File:** `app.ts:281–304`

`startAgentRun` appends `run.started` and `message.user` before validating that
the agent exists or confirming dispatch. If `dispatchRoot`/`driveAgentTurn`
fails, the error propagates without appending `run.failed`; the run remains
active and blocks later thread turns.

Validate `defaultAgent` at startup, atomically initialize the run, and append
a failure event when handoff fails.

### 17. SSE catch-up has a snapshot-to-live gap and inclusive cursor

**Priority:** Medium
**File:** `routes/stream.ts:23–75, 123–185`

Run and thread streams read a history snapshot before subscribing to the live
tail. An event committed in between appears in neither source.

Single-run reconnect passes `Last-Event-ID` directly to a store API whose
`fromSeq` semantics are inclusive. Reproduced: reconnecting after ID 2 received
IDs 2 and 3, duplicating the acknowledged frame.

Subscribe first then snapshot and deduplicate, or use a transactional
high-water mark. Resume with `afterSeq`/`lastId + 1`.

### 18. Inbound worker stops polling after one claim error

**Priority:** Medium (latent; High once wired)
**File:** `inbound-worker.ts:77–96, 101–132`

The timer invokes `void this.poll()` without a rejection handler. If `claimJob`
throws, `poll()` exits before scheduling the next poll, producing an unhandled
rejection and permanently stopping that worker. Reproduced: one claim, one
unhandled rejection, no retry.

Job completion and `markProcessed(messageId)` are also separate writes.
`completeJob` leaves the lease token in place, so if `markProcessed` throws the
catch path can move the already-completed job back to queued, repeating
side effects.

Catch at the poll-loop boundary, back off and always reschedule; make
message/job completion transactional.

### 19. Several JSON endpoints accept invalid shapes or turn them into 500s

**Priority:** Medium
**Files:** `routes/runs.ts:51–71`, `routes/schedules.ts:80–111`,
`routes/hitl.ts:171–179`

Reproduced:

- `POST /workflows/:name` with JSON `null` throws and returns 500;
- schedule creation accepts `enabled: "false"` and stores the string with 201;
- `trigger`, HITL `reason`, nested metadata, and workflow inputs have no
  structural or size validation.

Define shared runtime schemas, reject unknown/incorrect fields with 400, and
cap string/container depth and size.

### 20. Thread active-run and operator filtering are inconsistent

**Priority:** Medium
**File:** `routes/threads.ts:95–141, 169–172`

`GET /threads` ignores the `?userId=` operator filter. Reproduced:
requesting `userId=alice` returned both Alice and Bob's threads.

Thread view/message routes call `listRuns({ threadId, limit: 50 })` without
restricting roots or interactive kind. A background child can be selected as
the active conversation turn.

Honor an operator-only user filter and add a store query for the single active
root/interactive run.

### 21. Cookie-authenticated mutations lack explicit CSRF/cache policy

**Priority:** Medium
**Files:** `ui-session.ts:74–87`, `app.ts:243–264`,
`routes/runs.ts:267–277`

`SameSite=Lax` blocks ordinary cross-site POSTs, but there is no Origin or
CSRF token check for destructive cookie-authenticated routes such as cancel,
retention, reaping, and schedule tick. An untrusted same-site sibling origin can
submit these requests.

Validate `Origin`/Fetch Metadata or use CSRF tokens for cookie-auth mutations.

---

## Infrastructure & Quality Findings

### 22. Client-side filtering in HITL routes

**Priority:** Medium
**File:** `routes/hitl.ts:88–112`

The `/inputs` endpoint loads all inputs from the store, then filters by
ownership (resolving each run), then by `runId`, then by `threadId` (resolving
runs again). For deployments with thousands of pending inputs, this is O(N)
store lookups. Push `runId` and ownership filtering into the store query.

### 23. Event inspection loads the full log with no cursor pagination

**Priority:** Medium
**Files:** `routes/runs.ts:228–262`,
`ui/src/views/EventLog.tsx:20–66`

The route reads and hydrates the full run event log, then applies
category/text filters and slices the first 500 records. Long runs hide their
newest events while paying the cost of scanning everything.

Use indexed filters and cursor pagination.

### 24. OAuth/JWT endpoint configuration is insufficiently validated

**Priority:** Medium
**Files:** `app.ts:405–410`, `routes/oauth.ts:43–60`,
`jwt-auth.ts:26–69`

Without `baseUrl`, production redirect URIs silently use
`http://localhost:<port>`. `authorizeUrl` is built by string concatenation,
which mishandles an existing query string. Token and JWKS URLs accept
HTTP/internal targets without SSRF policy, and JWT issuer/audience checks are
optional. After a successful full-page OAuth flow, the callback returns raw JSON
instead of navigating the operator back to `/ui/#/connections`.

Require and validate an HTTPS external base URL when OAuth is enabled,
construct authorize URLs with `URL`, and require issuer/audience unless an
explicit unsafe mode is selected. Redirect successful/failed browser callbacks
back to the UI with a short-lived status code rather than token-bearing details.

### 25. The Ops UI calls an endpoint that does not exist

**Priority:** Medium
**Files:** `ui/src/api/client.ts:199–202`,
`ui/src/views/OpsView.tsx:10–15`

`OpsView` loads `/admin/jobs`, but the gateway removed the job-queue route.
A request returns 404, so the Ops screen always presents an error.

Remove the stale queue panel/client call or restore a capability-gated endpoint.

### 26. `/health` is liveness-only but is presented as service health

**Priority:** Medium
**File:** `app.ts:109`

The endpoint always returns 200 without checking the store, migrations,
workflow dispatcher, or required secrets. Render can route traffic to a gateway
unable to authenticate, persist, or dispatch work.

Split liveness and readiness. Keep a cheap process-liveness endpoint and use a
bounded readiness check for required configuration, database access, and
dispatcher availability.

### 27. Gateway typecheck/lint baselines are broken

**Priority:** Medium
**Files:** `package.json`, gateway tests

The package typecheck fails on three existing test type errors. Lint fails on
the empty catch in `routes/ui.ts`. The lint script covers only `src/`, not
`ui/src/`. No component-level UI tests exist, and no tests cover
`InboundWorker`, concurrent HITL resolution, concurrent schedule ticks, SSE
reconnect gaps, channel replay, production-mode defaults, body limits, or
workflow authorization.

Repair baseline errors, lint server and UI sources, and add the focused cases
in the missing-tests section.

### 28. Postgres live event tails are not tenant-scoped

**Priority:** Critical in shared-database deployments
**Files:** `routes/stream.ts:84–118`,
`packages/store/src/pg/postgres-store.ts:421–487`

The gateway's operator `/events/stream` trusts `store.events.tail({})` to be
tenant-local. The Postgres tail receives database-wide `NOTIFY` pointers and
reads events without a `tenant_id` predicate. If RLS is not enforced, one
tenant's operator stream can receive another tenant's events.

Include `tenantId` in every notification pointer and subscriber, add explicit
`tenant_id` predicates, and add a two-tenant Postgres SSE isolation test.

### 29. Deterministic channel thread IDs omit the tenant

**Priority:** High in shared-database deployments
**Files:** `app.ts:308–329`, `packages/store/sql/0001_threads.sql`

Channel conversations derive the thread ID from only `(channel,
conversationId)`. Two tenants using the same channel/conversation identifier
converge on the same primary key; `createThread ... ON CONFLICT DO NOTHING`
silently keeps the first row.

Include the runtime tenant ID in every deterministic external-resource key.

### 30. Latest Postgres migration drops the table gateway chat still uses

**Priority:** Critical
**Files:** `packages/store/sql/0017_thread_surfaces_items.sql:57–58`,
`packages/store/src/pg/postgres-store.ts:810–829, 1104–1110`,
`routes/threads.ts:103–127`, `app.ts:283–294`

Migration 0017 replaces `messages` with `thread_items` and drops the `messages`
table. The Postgres event fold still inserts every user/assistant message into
`messages`, and `getThreadMessages()` still selects from it.

On a fully migrated database, appending a chat `message.user` or reading a
thread fails with `relation "messages" does not exist`. Because
`startAgentRun()` appends `run.started` first, the failure can also leave a
running chat turn with no message, blocking subsequent turns.

Complete the projection/read migration to `ThreadItemStore`, or retain
`messages` until all call sites migrate. Add a Postgres chat test that applies
every migration before sending and reading a turn.

### 31. Crafted user IDs can mint operator stream tokens

**Priority:** Critical
**File:** `stream-token.ts:30–37, 50–70`

The signed payload is `${userId}|${role}|${expiresAt}`, while verification
destructures only the first three delimiter-separated fields. A valid user
principal whose ID is `alice|operator|<future timestamp>` produces a signed
payload that verifies as:

```json
{ "userId": "alice", "role": "operator" }
```

This was reproduced against the built package. The elevated token is accepted
on query-token paths, including the global operator event stream, enabling
cross-user run/event disclosure.

Sign a canonical JSON object or length-prefixed fields, validate its exact
shape, reject delimiter-bearing legacy payloads, and add adversarial identity
tests.

### 32. Cancellation response does not represent the run's actual state

**Priority:** High
**File:** `routes/runs.ts:267–277`

The route writes only a cooperative cancellation flag, then returns HTTP 200
with `{ status: "cancelled" }`. For a running model/tool this means only
"requested." A paused memory-store run has no active driver to append
`run.cancelled`, so its stored status remains paused and its SSE stream receives
no terminal event. Store backends also differ in how the cancellation request
affects projections.

Define an atomic cancellation state machine. Immediately append a canonical
cancellation event for parked/pending runs; return 202
`cancellation_requested` for active work and expose the eventual terminal state.

### 33. Webhook verification hashes decoded text, not the original bytes

**Priority:** Medium
**File:** `routes/channels.ts:51–90`

The body reader accumulates bytes, decodes them with `TextDecoder`, and the HMAC
helpers later encode that string as UTF-8. Invalid UTF-8 and binary multipart
content are changed before verification. A correctly signed one-byte `0xff`
payload was rejected.

Retain the bounded body as `Uint8Array`/`Buffer` for signature verification and
rebuild downstream requests from those exact bytes. Decode only when a channel
adapter requests text.

### 34. UI sessions have no server-enforced expiration or revocation

**Priority:** High
**File:** `ui-session.ts:52–82`

The signed cookie payload contains only `userId|role`. `maxAge` is a browser
storage instruction, not part of the signed value, so a copied cookie replayed
manually remains valid indefinitely. Rotating `RENDER_FACTORY_API_KEY` also does
not invalidate sessions minted with the old key.

Include signed `iat`, `exp`, and session/key-generation fields, enforce expiry
server-side, and support targeted revocation or cookie-secret rotation.

### 35. Global SSE reconnects can leave operator state stale

**Priority:** High
**Files:** `routes/stream.ts:80–118`, `ui/src/state/app.tsx:44–56`,
`ui/src/api/sse.ts`

The global stream emits IDs but intentionally has no catch-up behavior and
ignores `Last-Event-ID`. `AppProvider` refreshes counts only on initial mount or
when a later lifecycle/input frame arrives; `openSSE` exposes no reconnect/open
callback.

If connectivity drops while a run completes or an approval arrives, badges and
lists remain stale after EventSource reconnects until another relevant event
happens. A single `lastEvent` React state slot can also collapse bursts before
view effects observe each category.

Provide a replayable global cursor, or refetch every invalidated resource on
each EventSource `open`. Track per-category revision counters rather than one
last-event object.

### 36. The login key remains in React state after exchange

**Priority:** Medium
**File:** `ui/src/components/AuthGate.tsx:11–35`

After successful login, `AuthGate` switches to the application but never clears
its `key` state. The mounted component retains the long-lived operator key even
though the session cookie has already been issued. Later 401 responses also
remain ordinary view errors; the gate never returns to its logged-out state.

Clear key state immediately after exchange and centralize 401 handling so API
clients and SSE streams transition the application back to authentication.

### 37. Late token deltas can resurrect a completed conversation

**Priority:** Medium
**File:** `ui/src/hooks/useConversation.ts:82–90`

The client rejects a delta only when an active run ID exists and differs. If the
canonical refresh has already cleared the active run, a late delta is accepted
and changes `idle` back to `thinking`. Delta publication and durable completion
use independent asynchronous channels, so this ordering is possible.

Accept deltas only for a currently active nonterminal run and require monotonic
sequence advancement. The runtime should drain or close a run's delta
publication before durable completion.

### 38. The documented UI dev server cannot proxy authentication

**Priority:** Medium
**File:** `vite.ui.config.ts:20–34`

The proxy list omits `/whoami`, `/connections`, `/auth`, and the exact
`/ui/login` and `/ui/logout` routes. Under `pnpm dev:ui`, AuthGate sends its
session checks and login request to Vite rather than the gateway and cannot
authenticate.

Add explicit proxy entries for auth/connection endpoints without proxying the
entire `/ui/*` asset namespace.

### 39. Overlapping UI requests can regress state and hide failures

**Priority:** Medium
**Files:** `ui/src/hooks/useConversation.ts:44–70`,
`ui/src/views/RunsView.tsx:42–77`,
`ui/src/views/EventLog.tsx:29–43`

Conversation and run-list refreshes have no abort signal or request-generation
guard, so a slower old response can overwrite a newer terminal state or filter.
EventLog catches all root/child request failures—including 401 and 500—and
converts them to empty arrays, making outages look like empty traces.

Use `AbortController` or generation IDs and commit related state atomically.
Propagate root failures and suppress only specifically expected optional-child
errors.

### 40. Operator status summaries are inconsistent

**Priority:** Medium
**Files:** `routes/runs.ts:127–136`, `ui/src/lib/format.ts:22–35`

The API's `active` count excludes `pending`, while the rest of the gateway and
UI treat pending runs as active/busy. OAuth expiry timestamps use a past-only
relative-time formatter, so every future expiration displays as `"just now"`.

Define one active-status set shared by routes/UI and use a future-aware
`Intl.RelativeTimeFormat`/`timeUntil` formatter for expirations.

### 41. Routing and lazy views lack malformed/stale-deploy recovery

**Priority:** Low
**Files:** `ui/src/state/router.ts:22–45`, `ui/src/App.tsx:10–39`

`decodeURIComponent` is called without error handling, so a hash such as
`#/runs/%` throws during render. Path-style canonicalization discards
`location.search`. Suspense handles pending lazy imports but not a rejected old
chunk URL after a rolling deploy, which can blank a stale tab.

Decode defensively, preserve query parameters, and add an error boundary that
offers retry plus one guarded reload for chunk-load failures.

### 42. Interactive controls miss keyboard, focus, and labeling semantics

**Priority:** Medium
**Files:** `ui/src/components/Trace.tsx:129–158`,
`ui/src/views/EventLog.tsx:120–149`,
`ui/src/components/CommandPalette.tsx`,
`ui/src/components/AuthGate.tsx:49–69`, `ui/src/styles.css:18–75`

Trace and event disclosure rows are clickable `div`s without keyboard support,
button roles, or `aria-expanded`. The command palette and mobile rail do not
trap/manage focus or make background content inert. Several visible labels are
not associated with inputs, status/errors are not live regions, and small
faint/accent text falls below WCAG AA contrast in both themes.

Use semantic buttons/details and form labels, implement modal/rail focus
management, add live regions, and raise small-text contrast to at least 4.5:1.

---

## Correctly Enforced Boundaries

- Configured GitHub, Slack, Stripe, generic HMAC, and Standard Webhooks
  signatures are checked with constant-time comparison; timestamped schemes
  enforce replay windows. The current implementation is exact only for valid
  UTF-8 bodies (see #33).
- Channel bodies are streamed under a configurable byte cap before parsing.
- Standard `createGatewayApp` middleware rejects missing/invalid credentials,
  gates `/admin/*` to operators, and returns 404 for foreign run/thread/schedule
  IDs.
- Postgres encrypts OAuth access and refresh tokens with AES-256-GCM.
- OAuth connection lookup/delete is scoped to the authenticated user.
- SSE run/thread handlers re-check record ownership even after stream-token
  authentication.
- The UI does not persist the API key in browser storage or URLs, uses an
  httpOnly cookie after exchange, serves a restrictive CSP, blocks framing, and
  React/React-Markdown escape untrusted content by default. The in-memory key
  retention is tracked in #36.
- SQL-facing filters are passed through parameterized store APIs; no SQL
  injection path was found.

---

## Missing Tests

Add focused tests for:

1. security defaults with `NODE_ENV` unset in a production-style deployment;
2. query-key deprecation and exact stream-token path matching;
3. OAuth state/session binding, one-time consumption, replay, and PKCE;
4. workflow/schedule authorization for non-operator principals;
5. concurrent approve/deny and concurrent message resolution;
6. concurrent schedule ticks plus crashes before/after dispatch;
7. duplicate workflow- and agent-target channel deliveries;
8. inbound worker claim failures and transactional completion;
9. nested subagent approval bubbling to a workflow root;
10. failed interactive-agent handoff and partial opening-event writes;
11. SSE events committed between snapshot and subscription, plus
    `Last-Event-ID` exclusivity;
12. global JSON body limits, login throttling, and SSE connection limits;
13. null/primitive JSON bodies and schedule-create field types;
14. active thread selection with background children and more than 50 runs;
15. event-log cursor pagination and recent-event rendering;
16. CSRF/Origin handling for cookie-authenticated mutations;
17. required OAuth base URL, issuer/audience, and outbound URL validation;
18. two-tenant Postgres live-tail isolation;
19. deterministic channel-thread IDs across tenants.
20. fully migrated Postgres chat reads/message projections;
21. delimiter-bearing and malformed stream-token identities;
22. cancellation of running, pending, and paused runs across store backends;
23. binary and invalid-UTF-8 signed webhook payloads.
24. server-enforced session expiry, key rotation, and revocation;
25. global SSE disconnect/reconnect invalidation;
26. late deltas after durable completion;
27. development-server login/session proxying;
28. stale async responses, lazy-chunk recovery, and accessibility semantics.

---

## Recommended Remediation Sequence

1. **Close immediate critical failures:** migrate Postgres chat off the dropped
   table, replace delimiter-based stream tokens, and make HITL resolution
   single-writer.
2. **Make production security explicit:** remove `NODE_ENV`-dependent fail-open
   behavior, require secrets, and eliminate the shared operator key in URLs.
3. **Make decisions single-writer:** atomically resolve HITL inputs and claim
   schedule/channel deliveries before dispatch.
4. **Add authorization and resource policy:** workflow scopes, per-user quotas,
   body/rate/SSE limits, CSRF protection, and no-store response headers.
5. **Make handoff and resume durable:** persist parent-run ancestry, use outboxes
   and deterministic dispatch IDs, and fail partial run initialization.
6. **Repair streaming semantics:** close snapshot/live gaps and use exclusive,
   paginated, tenant-scoped cursors and notification pointers.
7. **Wire or remove dormant paths:** inbound worker/store and obsolete Ops queue
   UI.
8. **Harden the operator UI:** enforce session expiry, recover auth/SSE state,
   proxy dev auth correctly, and fix keyboard/focus semantics.
9. **Restore quality gates:** fix typecheck/lint, include UI linting, and add
   concurrency/security regression tests.
