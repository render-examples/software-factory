# Sprint 15 — Hooks (Event-Stream Middleware)

**Status:** DRAFT
**Wave:** 2 — Orchestration & Durability
**Depends on:** 03 (event append pipeline + `EventInterceptor` seam), 04 (runtime composition for injection), 07 (dispatch path converts a vetoed `tool.called` into an error `tool_result`)
**Unblocks:** —

---

## Goal

Implement hooks: auto-discovered event-stream middleware applied to every run. Each hook subscribes to event types/categories and runs before an event is appended, returning `continue` (optionally rewriting the event) or `reject` (a veto for gate categories like `tool`) — the lightweight extension point for cross-cutting concerns without reimplementing the loop.

---

## Foundational decisions in play

- [D10](../specs/00-foundations.md#d10--the-append-only-event-log-is-the-single-source-of-truth) — because everything is an event, hooks are simply subscribers/transformers on the event stream.

> **Layering note (resolved):** the user-facing `Hook` contract is defined in **`@render-factory/engine`** (runtime vocabulary), not `@render-factory/store`. The store exposes only a minimal, persistence-level [`EventInterceptor`](../specs/05-type-reference.md#eventinterceptor) seam (`(event, meta) → continue | rewrite | reject`, referencing only `RunEvent`). The engine **adapts** the `HookRegistry` into an `EventInterceptor` and the runtime **injects** it into the store's append path. `events.append` therefore knows `EventInterceptor`, never `Hook` — keeping `store` free of authoring concepts (see Sprints 01 & 03).

---

## Scope

**In:**
- **Discovery:** `hooks/*.ts` default-exporting a `Hook` (key = filename), auto-applied to all runs (collision-validated in Sprint 02). Also accept hooks via `createRuntime({ hooks })`, merged with discovered ones, into a `HookRegistry`.
- **`defineHook(spec)`** identity helper for typed authoring.
- **`Hook` → `EventInterceptor` adapter (engine):** wrap the `HookRegistry` in one `EventInterceptor` that, for each event, runs every hook whose `on` matches (by event `type` or whole `category`) in **registration order**, building `HookContext` (`runId`, `agentName?`, `logger`, `env`) from the interceptor `meta` + injected `logger`/`env`. The adapter collapses many hooks into the single seam the store runs.
- **Injection at runtime composition:** `createRuntime` builds the registry + adapter and hands the resulting `EventInterceptor` to the store's append path (the store seam left unset in Sprint 04 is now populated).
- **Hook semantics (realized in the engine/adapter + dispatch path):**
  - **observe** → `{ action: "continue" }`; event appended unchanged (side effects like metrics/Slack happen here).
  - **transform** → `{ action: "continue", event }` with a rewritten event (e.g. redact payload); the rewritten event is what the store persists/projects/streams.
  - **veto** → `{ action: "reject", reason }` (gate categories like `tool`): the runtime surfaces a rejected `tool.called` as an error `tool_result` the model can recover from — no crash. Complements per-agent `requireApproval`.
- **Fail-open/closed policy** (in the adapter): a throwing hook is logged and treated as `continue` for observers (fail-open); **gate hooks fail-closed** (treated as `reject`).
- **Single-write-path integration:** the interceptor runs inside `events.append`'s pre-commit phase, so hooks see exactly what projections/SSE will (one taxonomy), and a transform applies uniformly to persistence/projection/stream.

**Out:**
- The store's `EventInterceptor` seam *mechanism* itself (defined + run in Sprint 03/05) — this sprint provides the engine adapter + injection, not the append plumbing.
- Specific built-in hooks (loop detection, Slack notifier) — user/example code; this sprint ships the mechanism + one example hook for the scaffolder (Sprint 21).
- Per-agent hook wiring — hooks are global by design (no per-agent config).

---

## Deliverables

`@render-factory/engine` (authoring + adapter) + `@render-factory/sdk` (discovery/injection wiring):
- `Hook`/`HookResult`/`HookContext`/`HookRegistry` definitions (engine) + `defineHook` (authoring helper, re-exported by sdk).
- `hooks/` discovery loader + merge with `createRuntime({ hooks })` → `HookRegistry`.
- `HookRegistry` → `EventInterceptor` adapter honoring order, transform, veto, and fail-open/closed; `HookContext` construction.
- Runtime injection of the adapter into the store append path.
- Veto→error-`tool_result` handling for gate categories in the dispatch path.
- One illustrative example hook (e.g. `block-destructive` from the spec) as a fixture/scaffolder default.

---

## Porting source

- **New (D10)** — no direct source ([Porting Map](../specs/porting-map.md#1-from-agent-workflows-template-orchestration-kernel)). New code: discover `hooks/`; adapt the registry onto `store`'s `EventInterceptor`; run each appended event through hooks (observe/transform/veto) before commit.

---

## Implementation notes

1. **Hooks run via the injected `EventInterceptor` in the append pre-commit phase**, the one write path — so "anything observable in a trace is hookable." The store runs the interceptor; the engine adapter is what knows about `Hook`s. A transform changes the persisted+projected+streamed event uniformly.
2. **Gate semantics are category-scoped:** only gate categories (e.g. `tool`) may meaningfully `reject`; a rejected `tool.called` is converted by the dispatch path into an error `tool_result` (recoverable), mirroring a denied approval.
3. **Order matters + sync/async split (resolved — option A):** hooks stay on the single append write path. **Gates and transforms run synchronously** in the pre-commit phase (inside the append latency budget — must be fast); **pure observers return `continue` immediately** and schedule heavy work (Slack post, metrics) themselves *after* commit. Hooks run in registration order and must be side-effect-isolated. This keeps the one-taxonomy guarantee ("anything observable is hookable") without making every event wait on a slow observer.
4. **Fail-open for observers, fail-closed for gates:** a throwing observer is logged + `continue`; a throwing gate is treated as `reject` (safe default).
5. **Don't recurse:** side effects in a hook that emit further events must not deadlock the append; document that hooks observe, they don't re-enter `emit` synchronously.

---

## Exit criteria / acceptance

- A hook in `hooks/` is auto-discovered, adapted onto the store's `EventInterceptor`, and runs for matching events on every run; a `createRuntime({ hooks })` hook is also applied.
- `store` has no import of `Hook`/`HookContext` (build-graph guard from Sprint 01 still holds); the append path compiles against `EventInterceptor` alone.
- An observer hook fires side effects without altering the event; a transform hook's rewritten event is what gets persisted/projected/streamed.
- A gate hook rejecting a `tool.called` produces an error `tool_result`; the loop recovers (no crash).
- Registration order is respected; a throwing observer is logged and treated as `continue`; a throwing gate fails closed.
- The example `block-destructive` hook blocks the targeted tool and lets others through.

---

## Resolved decisions

- **Append-latency budget (option A):** hooks remain on the single append path; **gates + transforms run synchronously** (must be fast, inside the 5ms append NFR), while **pure observers return `continue` immediately and schedule their own async work after commit**. This preserves "transform before persist" for gates/transforms without letting a slow observer tax every event.
- **Veto for non-gate categories:** only gate categories (e.g. `tool`) may meaningfully `reject`; a veto returned for a non-gate event is treated as `continue` with a logged warning.
- **Hook ↔ HITL precedence:** the per-agent approval gate (`requireApproval`, dispatch step 2) runs **before** a hook veto (which fires at the `tool.called` emit), so **both must pass** — HITL approval is the human gate, the hook veto is the automated-policy gate (defense in depth). Precedence falls out of the dispatch order, so no extra coordination is needed.

## Risks / open questions

- **Slow synchronous gates:** a misbehaving gate/transform still regresses append latency for every matching event. Mitigate with a per-hook time budget + the fail-open/closed policy; keep gate logic trivial (allow-list checks, not network calls).
