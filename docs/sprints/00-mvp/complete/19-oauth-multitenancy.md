# Sprint 19 — OAuth & Multi-Tenancy

**Status:** DRAFT
**Wave:** 3 — Platform & Serving
**Depends on:** 07 (`ToolContext.connection` seam), 16 (gateway core)
**Unblocks:** —

---

## Goal

Give tools per-user credentials: persist encrypted per-`(userId, provider)` OAuth connections, expose authorize/callback/revoke routes, and resolve the run's `userId` into `ToolContext.connection(provider)` so tools act on a user's behalf rather than via a shared global token.

---

## Foundational decisions in play

- OAuth & multi-tenancy model from [Platform → OAuth & multi-tenancy](../specs/03-platform.md#oauth--multi-tenancy): tokens scoped by the run's identity, propagated through `DispatchOptions` to child runs/subagents.

---

## Scope

**In:**
- **`OAuthStore`** over `oauth_connections` (Sprint 05 table): `getConnection`, `upsertConnection`, `deleteConnection`, `listConnections`. Access/refresh tokens **encrypted at rest** (AES-256-GCM); scopes + expiry tracked.
- **OAuth HTTP routes** ([Platform → Gateway](../specs/03-platform.md#gateway)):
  - `GET /oauth/:provider/authorize` — initiation (HMAC-signed state).
  - `GET /oauth/:provider/callback` — exchange code → tokens → upsert connection.
  - `DELETE /oauth/:provider` — revoke + delete.
- **`ToolContext.connection(provider)`** real implementation (replacing Sprint 07's `undefined`): resolve the run's `userId` against `OAuthStore`; return `OAuthTokens` or `undefined` when no user (system/cron) or no connection. Token refresh via `SELECT FOR UPDATE` to avoid races.
- **Identity propagation:** `userId` from the gateway's auth → run → `DispatchOptions` → child runs/subagents → `ToolContext`. (The propagation plumbing exists from Sprints 11/14; this sprint consumes it for OAuth.)
- **Tool contract:** OAuth-dependent tools return a clear error result when `connection()` is `undefined` (documented in Sprint 07; verified here).

**Out:**
- An OAuth connection-management UI (out of scope per [Operator UI scope](../specs/06-operator-ui.md#scope)).
- Provider-specific connector packages (Slack/Linear/GitHub app installs) — the mechanism is here; specific providers are user/example code (some webhook side in Sprint 20).

---

## Deliverables

`@render-factory/gateway` (+ `store` for `OAuthStore`):
- `OAuthStore` with AES-256-GCM encryption + `SELECT FOR UPDATE` refresh.
- `/oauth/:provider/{authorize,callback}` + `DELETE /oauth/:provider` routes with HMAC state signing.
- `ToolContext.connection(provider)` resolution against the run's `userId`.
- Encryption key management via env (`RENDER_FACTORY_ENCRYPTION_KEY`; documented in Sprint 23 config).

---

## Porting source

- **H — OAuth implementation:** `render-agent-harness/.../core/src/connections.ts` — port AES-256-GCM encryption, `SELECT FOR UPDATE` refresh, the `SecretsContext` builder; adapt to `OAuthStore` + `ToolContext.connection()`.
- **H — OAuth HTTP routes:** `web/src/routes/connections.ts` — port `/start`, `/callback`, `DELETE`; adapt HMAC state signing to the spec route names.

---

## Implementation notes

1. **Encryption at rest:** tokens are encrypted with a server-held key (env); never logged or returned in API responses. Decrypt only when handing `OAuthTokens` to a tool.
2. **Refresh races:** concurrent runs for the same user can race on refresh; use `SELECT FOR UPDATE` on the connection row so only one refresh proceeds and others read the refreshed token.
3. **`userId` is the resolution key:** `connection(provider)` uses the run's `userId` (propagated to children). System/cron runs have no `userId` → `connection()` returns `undefined`.
4. **State signing:** HMAC-sign the OAuth `state` param to prevent CSRF; verify on callback.
5. **Graceful absence:** never throw from `connection()`; tools branch on `undefined` and return a clear error result.

---

## Exit criteria / acceptance

- A user completes `authorize`→`callback`; a connection is stored encrypted; `ToolContext.connection(provider)` returns valid `OAuthTokens` for that user's run.
- An expired token is refreshed transparently; two concurrent runs for the same user don't double-refresh (one wins via `SELECT FOR UPDATE`).
- `DELETE /oauth/:provider` revokes + deletes; subsequent `connection()` returns `undefined`.
- A system/cron run (no `userId`) gets `undefined` from `connection()`; an OAuth-dependent tool returns a clear error result (no throw).
- `userId` propagates to a subagent/child task and resolves the same connection there.
- Tokens are never present in logs or API responses; state is HMAC-verified on callback.

---

## Risks / open questions

- **Encryption key rotation:** define how the AES key is provisioned (env) and whether rotation is supported (re-encrypt on read?). MVP: single key via env; document rotation as future.
- **Provider diversity:** authorize/callback flows differ per provider (scopes, PKCE); MVP supports the generic OAuth2 auth-code flow; per-provider quirks may need small adapters.
- **Token leakage surface:** audit logs/traces/SSE to ensure tokens never appear; `tool.called` inputs for OAuth tools must not embed the token (it comes from `connection()`, not tool input).
