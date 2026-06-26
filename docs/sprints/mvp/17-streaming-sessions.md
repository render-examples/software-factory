# Sprint 17 — SSE Streaming + Threads

**Status:** DRAFT
**Wave:** 3 — Platform & Serving
**Depends on:** 05 (`EventLogStore.tail`, threads table), 13 (awaiting-input pause/resume — how a turn is delivered into the active run, and how a thread is revived), 16 (gateway core)
**Unblocks:** —

---

## Goal

Add real-time streaming and multi-turn state to the gateway: the SSE endpoints as a live tail of the event log (resumable by `seq`), plus thread management. A **thread** is the top-level unit of work — a durable line of work (owned by a `userId`) served by a *sequence* of runs (one active at a time); the gateway proxies messages into the active run and tails the thread's events out — it never runs an agent loop itself.

---

## Foundational decisions in play

- [D10](../specs/00-foundations.md#d10--the-append-only-event-log-is-the-single-source-of-truth) — the SSE stream is a live tail of the log; the same `RunEvent` taxonomy is persisted and streamed (no separate SSE vocabulary).

---

## Scope

**In:**
- **SSE routes** ([Platform → Gateway](../specs/03-platform.md#gateway)):
  - `GET /runs/:id/stream` — SSE of a single run's events.
  - `GET /threads/:id/stream` — thread stream that **stays open across the thread's runs** (when a thread is revived under a new run, the new run's events carry the same `threadId`, so the tail picks them up without a client reconnect).
- **SSE = `EventLogStore.tail`:** Postgres `LISTEN/NOTIFY` (Sprint 05) → filter by `runId`/`threadId` → serialize the full `RunEvent`; resume from a `seq` offset on reconnect (`Last-Event-ID`/query param).
- **Event taxonomy on the wire:** the full categories — lifecycle, message (`message.assistant`; `text.delta` is **post-MVP**, until then text arrives as `message.assistant`), tool, step, model, approval, delegation, context. Subscribe by category. Maps onto AG-UI for frontend interop.
- **Threads** ([Platform → Threads](../specs/03-platform.md#threads)):
  - `POST /threads` — create a thread (optional `userId`, `metadata`, `workflow`).
  - `GET /threads` — list threads (optional `?userId=`).
  - `POST /threads/:id/messages` — deliver a user message to a thread; if the thread has a **live active run awaiting input** (status `paused`, `reason: "input"`), the message is delivered into it via `/runs/:id/input`, which **appends a `message.user` event** the parked `awaitInput()` picks up (cheap, no dispatch). If the thread has **no live run** (first message, or the prior run was deprovisioned), the gateway **dispatches a new run for the thread** that rehydrates prior context from the log, then delivers the message. The `message.user` event is the recording — the `ThreadMessage`/`messages` list is a projection folded from `message.user`/`message.assistant` (keyed by `threadId`). **The gateway never runs the agent loop** — the workflow task container does (see [Platform → Threads](../specs/03-platform.md#threads)).
- **`ThreadStore`** implementation over the Sprint 05 tables (`threads`, `messages`), including `getThreadMessages` (cross-run history for rehydration).
- **One active run per thread + turn-level busy:** the partial unique index `idx_runs_thread_active` guarantees a single live run per thread (and prevents a revival race from spawning two); a message arriving while the active run is mid-turn (status `running`, not awaiting input) → `409 thread_busy`.

**Out:**
- Token-level `text.delta` streaming (post-MVP; gated on `ModelClient.stream`).
- Approvals over SSE / approval routes (Sprint 18) — though `approval.*` events do flow on the stream.
- The viewer UI that consumes these streams (Sprint 22).

---

## Deliverables

`@render-agents/gateway`:
- SSE handler over `EventLogStore.tail` with reconnect/`seq` resume + heartbeat.
- Run stream + thread stream routes.
- `ThreadStore` (interface + Postgres impl in `@render-agents/store`) + thread routes + message delivery/revival triggering (routes in gateway).
- `409 thread_busy` enforcement.

---

## Porting source

- **H — SSE streaming:** `render-agent-harness/.../web/src/routes/runs.ts` (SSE handler) + `core/src/state/repo.ts` (NOTIFY) — port the pointer-payload NOTIFY + dedicated `pg.Client` LISTEN, pointed at `run_events`; resumable from `seq`.
- **H — Thread model:** `web/src/routes/conversations.ts`, `core/src/state/repo.ts` — port `loadConversationMessages` (cross-run history — keep it; a thread's history spans its runs), sequential-only enforcement (unique index), `409` busy response. **Adaptation:** rename the harness's "conversation" to **thread**; the harness already spreads a thread across many runs, which is exactly the model here — the only change is that while a run is alive the gateway delivers turns into it (awaiting-input) instead of dispatching a fresh run per turn.
- **H — Thread routes:** harness session/conversation routes — adapt to `ThreadStore` + spec route shapes. **Adaptation:** the harness's session-grouping layer is dropped; a thread carries its own `userId`/`metadata` and is the top-level record (filter by `userId` for a user's threads).

---

## Implementation notes

1. **No separate SSE vocabulary.** The stream serializes the same `RunEvent`s the store persists; clients filter by category. This is also the AG-UI mapping point.
2. **Reconnect is `seq`-driven:** on connect, optionally catch up from `fromSeq` via `tail`'s catch-up read, then live-stream. Send periodic heartbeats/comments to keep proxies open.
3. **Thread streams span the thread's runs:** filter the tail by `threadId`; every run that serves the thread (the original and any revival) emits under the same `threadId`, so one open stream covers the thread's whole life.
4. **Sequential turns:** the partial unique index keeps one active run per thread (and serializes revival). Turn-level mutual exclusion is a check on the active run's state — a message delivered while it is mid-turn (status `running`, not awaiting input) returns `409 thread_busy`.
5. **Message delivery vs. revival:** resolve the thread's active run first. If it's live and awaiting input (`paused`, `reason: "input"`) → `POST /runs/:id/input` appends a `message.user` event (Sprint 13/18); no dispatch. If there is no live run → dispatch the thread's workflow run (chosen once at thread creation), let it rehydrate from `getThreadMessages` (cross-run), then deliver. Either way the recording is the `message.user` event on the serving run; the `messages`/`ThreadMessage` list is its projection (folded with `message.assistant`, keyed by `threadId`). The gateway only proxies (relay message in, tail events out) — the workflow task container executes the loop.

---

## Exit criteria / acceptance

- `GET /runs/:id/stream` streams a run's events live; disconnect + reconnect with a `seq` offset resumes without loss or duplication; SSE delivery < 100ms from append ([NFR](../specs/04-operations.md#non-functional-requirements)).
- `GET /threads/:id/stream` stays open across multiple turns **and across a run revival** (deprovision + new run), emitting every serving run's events under the one `threadId`.
- `POST /threads` / `POST /threads/:id/messages` / `GET /threads` work; the first message dispatches the thread run, a message to a live-awaiting thread is delivered without a new run, a message to a deprovisioned thread revives it (new run rehydrated from the log), and each message is linked to its serving run.
- A concurrent second turn on a busy thread returns `409 thread_busy`.
- Events on the wire match the persisted `RunEvent` taxonomy (category-subscribable).

---

## Risks / open questions

- **Missed NOTIFY gap:** between catch-up read and live subscribe, an event could slip; bridge by overlapping (subscribe first, then catch up from last seen `seq`, dedupe).
- **Connection scaling:** each SSE client holds a connection; the single LISTEN client fans out in-process. Many clients per instance — ensure fan-out is in-memory, not one LISTEN per client.
- **Revival races:** two messages arriving for a deprovisioned thread could both try to dispatch; rely on `idx_runs_thread_active` to make the second dispatch fail, and translate that into a deliver-into-the-just-created-run (or `409 thread_busy`) rather than an error.
- **`text.delta` post-MVP:** clients should treat absence of deltas as "text arrives whole in `message.assistant`"; document so the viewer (Sprint 22) doesn't assume token streaming.
