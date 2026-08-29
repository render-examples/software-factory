
# Gateway Package Audit

Audit of `packages/gateway/` (17 source files, ~3,600 lines).

---

## Bugs

### 21. `/runs/counts` loads all runs into memory to count them

**File:** `routes/runs.ts:117–137`

```ts
const buckets = await Promise.all(
  RUN_STATUS_LIST.map((status) =>
    store.listRuns({
      workflow, threadId, userId, roots,
      status: status as import("@render-factory/store").RunStatus,
    }),
  ),
);
const counts = {
  pending: buckets[0].length,
  running: buckets[1].length,
  ...
};
```

Six separate `store.listRuns()` calls fetch every run record per status, then
take `.length`. This materializes *all* runs just to count them. A single
`COUNT(*) … GROUP BY status` query (or a dedicated `store.countRuns()` method)
would cut memory and latency by orders of magnitude for any non-trivial
deployment.

### 22. `getPrincipal` falls back to operator on missing auth

**File:** `auth.ts:146`

```ts
export function getPrincipal(c: Context): Principal {
  return c.get("principal") ?? { userId: DEFAULT_OPERATOR_ID, role: "operator" };
}
```

If the auth middleware fails to set a principal (middleware ordering bug,
uncaught error, or a route registered before the middleware), the fallback
silently grants **operator** access — the highest privilege level. This should
either throw or return a restrictive `role: "user"` with a sentinel userId to
fail-closed. The comment says "defaulting to a local operator when auth is
disabled" but the function has no way to know whether auth was intentionally
skipped.

### 23. OAuth tokens stored without encryption at the gateway layer

**File:** `routes/oauth.ts:90–101`

```ts
const conn: OAuthConnection = {
  ...
  accessToken: tokens.access_token,
  refreshToken: tokens.refresh_token,
  ...
};
await oauthStore.upsertConnection(conn);
```

The gateway imports `encrypt`/`decrypt` from `@render-factory/store` but never
applies them before persisting tokens. The `encryptToken`/`decryptToken` are
re-exported as deprecated aliases (lines 184–186) but unused in the actual
`upsertConnection` call. Unless the store layer internally encrypts (which the
separate export of `encrypt`/`decrypt` suggests it doesn't), OAuth
access/refresh tokens sit as plaintext in the database.

### 24. `JSON.stringify` on channel input can throw on circular references

**File:** `app.ts:328`

```ts
const text = typeof input === "string" ? input : (JSON.stringify(input) ?? "");
```

`input` comes from `channel.parse()`, which is third-party-authored code. If it
returns an object with circular references, `JSON.stringify` throws an unhandled
`TypeError`. Wrapping in try-catch would prevent channel parse quirks from
crashing the handler.

### 25. `hitl.ts` creates two independent run caches in a single request

**File:** `routes/hitl.ts:90, 106`

The `/inputs` handler calls `newRunCache()` for ownership filtering (line 90),
then if `threadId` filtering is also active, calls `newRunCache()` again
(line 106) — creating a second independent cache. Run lookups from the
ownership pass are thrown away and re-fetched. Should reuse a single cache
instance per request.

---

## Security Issues

### 26. Stream token and OAuth state share the same HMAC secret without domain separation

**Files:** `stream-token.ts`, `routes/oauth.ts`

Both subsystems use HMAC-SHA256 over the same secret (the cookie/encryption
key), but neither includes a purpose prefix in the signed payload. A stream
token payload is `base64url(userId|role|expiresAt)` and an OAuth state is
`base64url(JSON(provider, userId, nonce, ts))`. While the payload structures
differ enough that a practical collision is unlikely, a purpose-binding prefix
(e.g. `"stream:"` or `"oauth:"` prepended before HMAC) is standard practice to
prevent cross-purpose forgery.

### 27. OAuth `exchangeCode` and `buildRefresher` have no SSRF guard

**File:** `routes/oauth.ts:159–178, 133–156`

Token endpoint URLs are operator-configured strings. The HTTP calls to these
endpoints use the global `fetch` without any SSRF protection. A misconfigured
or compromised `tokenUrl` pointing to an internal address (e.g. cloud metadata
at `169.254.169.254`) would be followed without validation. The engine provides
`ssrfFetch` / `assertUrlAllowed` for exactly this purpose; the gateway should
use them (with `allowPrivateHosts: false`) for token exchanges.

### 28. UI asset path traversal check doesn't handle encoded paths

**File:** `routes/ui.ts:84`

```ts
if (file.includes("..") || file.includes("/")) return c.text("not found", 404);
```

The check runs on the Hono route param (already URL-decoded by the framework),
so `%2f` → `/` is caught. However, double-encoding (`%252e%252e`) would survive
as literal `%2e%2e` if the file hits another decode layer. In practice this is
safe because `readFile` treats them literally on Linux, but the guard should
normalize before checking (or use `path.resolve` and verify the result is within
the UI directory).

### 29. Ephemeral cookie secret silently accepted in production

**File:** `ui-session.ts:117–126`

There is no mechanism to prevent production deployments from running without
`RENDER_FACTORY_COOKIE_SECRET` — the gateway silently generates a random
per-process secret and sessions break on restart. Consider refusing to start in
production without an explicit secret (fail-closed) rather than falling back.

---

## Code Smells & Design Issues

### 30. `createGatewayApp` is a 350-line monolith

**File:** `app.ts:76–421`

This single function configures auth, resume logic, admin routes, thread
handling, channel message handling, OAuth, channels, and wires everything up. It
would benefit from extracting: `configureAuth()`, `buildResumeDriver()`,
`buildChannelMessageHandler()`, and `mountApiRoutes()` helpers.

### 31. `toApproval` mapper duplicated across three files

The identical `toApproval` mapping function appears in `routes/runs.ts:34`,
`routes/threads.ts:36`, and is conceptually replicated in
`routes/hitl.ts:114`. Should be a shared utility.

### 32. `driveResume` helper duplicated in `hitl.ts` and `threads.ts`

Both files define an identical fire-and-forget resume helper:

```ts
const driveResume = (runId: string): Promise<void> => {
  if (!resume) return Promise.resolve();
  const p = Promise.resolve(resume(runId)).then(() => {}).catch(...);
  return awaitResume ? p : Promise.resolve();
};
```

Should be extracted to a shared module.

### 33. `parseNonNegativeInt` duplicated in `runs.ts` and `stream.ts`

Both files define identical input parsing helpers. Extract to a shared
`parse-utils.ts`.

### 34. Client-side filtering in HITL routes

**File:** `routes/hitl.ts:88–112`

The `/inputs` endpoint loads all inputs from the store, then filters by
ownership (resolving each run), then filters by `runId`, then filters by
`threadId` (resolving runs again). For deployments with thousands of pending
inputs, this is O(N) store lookups. Push `runId` and ownership filtering into
the store query.

### 35. `startGateway` close method uses unsafe type assertion

**File:** `app.ts:438–443`

```ts
close: () => {
  if (typeof (server as { close?: () => void }).close === "function") {
    (server as { close: () => void }).close();
  }
},
```

`@hono/node-server`'s `serve()` returns a `node:http.Server` which always has
`.close()`. The cast obscures the real type and would mask a breaking change in
the server library. Type the return properly.

### 36. Duplicate `pauseReason` extraction logic

**File:** `routes/runs.ts:160–166, 181–187`

The backward-scan for the last `run.paused` event to extract `pauseReason` is
copy-pasted between `/runs/:id` and `/runs/:id/view`. Should be a shared helper
or a store projection.

---

## Refactoring Opportunities

### 37. Add `store.countRuns()` for the counts endpoint

Replace the 6× `listRuns` + `.length` pattern with a single SQL query that
returns `{ status: count }` buckets. This is the most impactful performance fix.

### 38. Extract route-shared utilities

`toApproval`, `driveResume`, `parseNonNegativeInt`, `parsePositiveInt`, and
`pauseReason` extraction all appear in 2+ route files. A `routes/_shared.ts`
module would eliminate ~100 lines of duplication.

### 39. Push input filtering into the store

The `/inputs` endpoint's client-side ownership and threadId filtering should be
pushed into `store.listInputs({ userId, threadId })` to avoid loading all inputs
then filtering in JS.

### 40. Encrypt OAuth tokens before storage

Either call `encrypt(token, key)` in the gateway before `upsertConnection`, or
move encryption into the store's `upsertConnection` method. Make the boundary
explicit and test it.

### Gateway Priority Matrix

| Category | Critical | Notable | Minor |
|----------|----------|---------|-------|
| Bugs | #22 (operator fallback), #23 (OAuth plaintext) | #21 (count perf), #24 (JSON.stringify), #25 (cache) | — |
| Security | #26 (HMAC domain sep), #27 (SSRF on OAuth) | #28 (path traversal), #29 (ephemeral secret) | — |
| Code Smells | — | #30 (monolith app.ts), #34 (client-side filter) | #31, #32, #33, #35, #36 |
| Refactoring | — | #37 (countRuns), #38 (shared utils), #39 (push filters), #40 (encrypt tokens) | — |

**Recommended first fixes:** #22 (operator fallback — privilege escalation
risk), #23/#40 (OAuth token encryption), #21/#37 (counts performance).
