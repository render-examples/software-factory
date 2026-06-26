# Sprint 03 — Event Log + In-Memory Store + Projection Fold

**Status:** DRAFT
**Wave:** 0 — Foundations & Walking Skeleton
**Depends on:** 01 (type contracts)
**Unblocks:** 04 (loop emits events), 05 (Postgres store), 10 (tracing)

---

## Goal

Build the keystone: the append-only event log and the **projection-fold framework** that derives every read model (runs, messages, spans, tool-calls, steps, approvals, cost, status) from the log — implemented first as an in-memory `RunStore` so the rest of Wave 0 can run with zero infrastructure. This sprint establishes the *single write path* (`events.append`) that all later runtime code uses.

---

## Foundational decisions in play

- [D10](../specs/00-foundations.md#d10--the-append-only-event-log-is-the-single-source-of-truth) — the append-only event log is the single source of truth; projections are folds, never independently authored.
- [D4](../specs/00-foundations.md#d4--workflows-orchestrate-postgres-persists) — Postgres (here, the in-memory stand-in) holds the run's append-only event log; resume is driven from the log.
- [D8](../specs/00-foundations.md#d8--observable-by-default-every-unit-is-a-span-postgres-is-source-of-truth) — spans are a projection of span-producing events.

---

## Scope

**In:**
- **`RunEvent` taxonomy realized as data** — the discriminated union from [Type Reference → RunEvent](../specs/05-type-reference.md#runevent), with the [`EventCategory`](../specs/05-type-reference.md#eventcategory) mapping ([Execution → Events](../specs/02-execution.md#events) category table) and the rule "subscribe by category, not by name."
- **`EventLogStore` (in-memory):** `append(event)` assigns a gap-free `seq`, runs the optional **`EventInterceptor`** pre-commit seam (continue/rewrite/reject), updates affected projections atomically, and exposes a tail; `read(runId, fromSeq?)`; `tail(filter, signal)` as an async iterable (in-memory pub/sub stand-in for `LISTEN/NOTIFY`).
- **`EventInterceptor` seam:** the persistence-level pre-commit hook point (`(event, meta) → continue | rewrite | reject`) that `append` invokes before persisting/projecting/notifying. The store defines and runs it but references **only** the event vocabulary — it knows nothing about `Hook`s. The engine's hook adapter (Sprint 15) is injected here at runtime composition; in this sprint the seam is optional/absent and tested directly with a stub interceptor.
- **The projection-fold framework:** a registry of folders, each consuming relevant event types and maintaining a derived read model. Implement the MVP projections needed by Wave 0–1 reads:
  - `runs` (status from latest lifecycle event; `totalCostUsd` folds **this run's** `llm.call` events — per-run, not cross-run. Delegation/all-in totals are a read-layer aggregate over `subagent.spawned.childRunId`, not a fold here — see Sprint 10/14).
  - `run_messages` (model-visible history folded from `message.*`/`tool.*`).
  - `spans` (folded from span-producing `*.started`/`*.completed` events carrying `spanId`/`parentSpanId`).
  - `tool_calls` (idempotency index: keyed by `idempotencyKey`, records canonical terminal `tool.result`).
  - `workflow_steps` (memoized `step.completed` by `(runId, name)`).
  - `approval_requests` (folded from `approval.requested`/`approval.resolved`).
- **`RunStore` read surface** over those projections: `getRun`, `listRuns`, `getMessages`, `listSpans`, `getStepResult`, `getToolResult`, plus `init()`/`close()`.
- **`idempotencyKey(runId, suffix)`** helper (`SHA-256`) used by both the tool-call key and dispatch key.
- **Provider-placeholder exclusion:** transport-only `tool_result` placeholders must not be folded into the `tool_calls` idempotency projection or counted as applied (see [Execution → HITL](../specs/02-execution.md#hitl-pause--resume) and [Tool dispatch](../specs/02-execution.md#tool-dispatch)).
- **Event immutability + versioning:** events carry a `version`; the log is append-only; projections are rebuildable by replaying `read()` **for any run whose events are still retained** (reconstruction is bounded by the retention horizon — Sprint 23 — after which trimmed runs keep only their `runs` summary).

**Out:**
- Postgres implementation, migrations, advisory lock, real `LISTEN/NOTIFY` (Sprint 05).
- The runner that *emits* these events (Sprint 04) — here we test by appending events directly.
- HITL/cancellation *runtime* behavior (Sprints 13) — the approval/cancel projections exist, but resume orchestration is later.
- Retention/cleanup (Sprint 23).

---

## Deliverables

`@render-agents/store`:
- In-memory `EventLogStore` with atomic append→fold→notify.
- Projection folders (one per derived table), each pure over `(currentProjection, event) → nextProjection`, registered with the store.
- In-memory `RunStore` implementing the [Type Reference contract](../specs/05-type-reference.md#runstore) (reads only over projections; **no** `createRun`/`startSpan`/`appendRunMessage` writers — those are internal effects of append).
- A `replay(runId)` utility that rebuilds all projections from the log (proves projections are pure folds).
- `idempotencyKey` helper.

---

## Porting source

- **T — Store (memory):** `agent-workflows-template/src/engine/store/memory.ts`, `store/index.ts` — reference for the in-memory store shape, **but re-center on the event log**: the template persists messages/spans directly; here those become folds of `events.append`. Per [Porting Map](../specs/porting-map.md#1-from-agent-workflows-template-orchestration-kernel), "the harness's separate message-persistence, idempotency store, and NOTIFY emission all collapse into `events.append`."
- **H — Run state repo (append pattern):** `render-agent-harness/.../core/src/state/repo.ts` — reference for the append + `next_seq()` pattern and folding status/messages; `next_seq()` becomes the event log `seq`.

---

## Implementation notes

1. **Append is the only mutation.** Model `append` as: validate → assign `seq` (monotonic per `runId`) → apply each registered folder → publish to tail subscribers. Keep it synchronous/atomic in memory; the Postgres version (Sprint 05) makes this a transaction.
2. **Folders are pure and independently testable.** Each folder declares which event types it consumes. A new projection = a new folder; no runtime code writes a projection directly.
3. **`seq` is gap-free and total per run** — it is the resume offset and the SSE reconnect cursor. The `(runId, seq)` pair uniquely identifies an event.
4. **Tail = in-memory NOTIFY stand-in.** Implement `tail` as an async iterable backed by an event emitter + a catch-up read from `fromSeq`, so the Sprint 17 SSE work can swap the transport without changing the contract.
5. **Span fold detail:** `*.started`/`*.completed` pairs carry `spanId`/`parentSpanId`; the `spans` projection assembles the tree. `llm.call` carries usage/cost folded into the agent span and `runs.totalCostUsd`.
6. **Idempotency fold:** only canonical terminal `tool.result` events populate `tool_calls`; provider placeholders are tagged and skipped.

---

## Exit criteria / acceptance

- Appending a scripted sequence of `RunEvent`s yields correct projections for every read method (`getRun` status + cost, `getMessages` folded history, `listSpans` tree, `getStepResult`, `getToolResult`).
- `replay(runId)` rebuilt purely from `read()` produces byte-identical projections to the incrementally-folded ones (proves folds are deterministic and the log is sufficient).
- `tail` delivers appended events to a live subscriber and supports catch-up from a `seq` offset.
- A canonical terminal `tool.result` populates the idempotency projection; a provider-placeholder `tool_result` does not.
- Out-of-order or duplicate `seq` is rejected; events are immutable once appended.

---

## Risks / open questions

- **Fold/transaction parity with Postgres:** the in-memory atomic append must mirror what Sprint 05 does in a single SQL transaction; keep the folder interface storage-agnostic so the Postgres store reuses the same folders (or a faithful SQL translation).
- **Projection coupling:** resist letting folders read each other's outputs (keep each a pure fold of the log). Cross-projection reads belong in the read API, not the fold.
- **Cost folding precision:** `totalCostUsd` is `NUMERIC` in Postgres; in memory use a precise representation to avoid float drift surprises when compared in tests.
