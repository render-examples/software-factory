# Sprint 02-S — Token-Level Streaming: transient deltas without clogging the log

**Status:** IMPLEMENTED
**Wave:** Post-MVP — Interactivity & UX
**Depends on:** 05 (Postgres event log + `LISTEN/NOTIFY`), 03 (gateway SSE), 01-Q (two-lane execution; chat lane / warm worker)
**Unblocks:** real-time chat UX (tokens as they generate), a foundation for future streamed tool-call args / reasoning

---

## Goal

Stream assistant output **token-by-token** to the operator UI (and any SSE client) as the model generates it — without persisting a torrent of per-token events into the event-sourced database.

Today a turn shows nothing until the model finishes, then the whole `message.assistant` lands at once (the chat UI debounces a transcript refetch on each event). That is correct but feels dead during a long answer. Naively fixing it by emitting a `text.delta` **event per token** would violate [D10](../specs/00-foundations.md#d10--the-append-only-event-log-is-the-single-source-of-truth): a 500-token reply becomes 500 log rows, each folded through projections and `pg_notify`, retained forever — ~100× write amplification on the hottest path, for data with **zero value as history** (the finished message supersedes every delta).

So deltas become a **transient side channel** ([D13](../specs/00-foundations.md#d13--token-deltas-are-transient-the-event-log-stays-durable-only)): they ride a separate `DeltaBus`, never touch `run_events`, and the single durable fact for a turn stays the one `message.assistant` event.

---

## Foundational decisions in play

- [D13](../specs/00-foundations.md#d13--token-deltas-are-transient-the-event-log-stays-durable-only) — token deltas are transient; the log stays durable-only. Introduced by this sprint.
- [D10](../specs/00-foundations.md#d10--the-append-only-event-log-is-the-single-source-of-truth) — the log is the single source of truth. Deltas are **out-of-band** precisely so this property holds; the append path *rejects* a transient event as a guard.
- [D12](../specs/00-foundations.md#d12--two-execution-lanes-durable-workflows-vs-interactive-chat) — two lanes. The `DeltaBus` mirrors the store/queue seam so the warm worker (generation) and gateway (SSE) can be different processes: Postgres `NOTIFY` in production, in-memory in `inline` dev.
- [D5](../specs/00-foundations.md#d5--composition-over-configuration-one-runtime-object) — one runtime object. `deltaBus` is auto-detected (Postgres vs memory) and injectable, exactly like `store` and `jobQueue`.

---

## Architecture

```
   provider stream (SSE/chunks)
            │  text_delta, text_delta, …            durable, once per turn
            ▼                                        ┌───────────────────────┐
   DefaultRunner.callModel ──────────────────────────▶ ctx.emit(message.assistant)
     • model.stream() preferred                       │  ctx.emit(llm.call)     │→ run_events
     • coalesce (≤50ms / ≤120 chars)                  └───────────────────────┘
            │  ctx.streamDelta(coalescedText)                     │ pg_notify('run_events')
            ▼                                                     ▼
      DeltaBus.publish  ── pg_notify('run_deltas') ──▶  gateway SSE  ◀── events.tail (durable)
            │  (in-memory fan-out for inline dev)                  │  merge
            ▼                                                      ▼
   (never persisted, never folded, never retained)      one SSE stream: durable events (with id)
                                                         + text.delta frames (no id)
                                                                   │
                                                                   ▼
                                                         ChatView: render deltas live,
                                                         replace with canonical message
```

Two transports behind one `DeltaBus` interface (mirrors `createStore` / `createJobQueue`):

| Impl | When | Fan-out |
|---|---|---|
| `MemoryDeltaBus` | `inline` dev / tests (no `DATABASE_URL`) | in-process `Set` of subscriber queues |
| `PgDeltaBus` | production (Postgres) | `pg_notify('run_deltas')` → **one shared `LISTEN` connection per process**, demultiplexed in-memory to per-run/-thread subscribers |

---

## Design decisions

**1 — Transport: Postgres `NOTIFY` on a dedicated `run_deltas` channel (payload carried inline).**
Reuses infra already in place for `run_events`/`run_jobs`; no new dependency (Redis, etc.). Delta payloads (coalesced text + small fields) sit far under the NOTIFY size limit. `NOTIFY` has **no replay** — accepted: a client connecting mid-turn simply misses prior deltas and converges on the durable message.

**2 — Deltas are transient, with a hard guard.**
`text.delta` stays in the `RunEvent` taxonomy (it is the *wire* shape SSE clients subscribe to under the `message` category) but is listed in `TRANSIENT_EVENT_TYPES`; **both** store `append` implementations throw if a transient event is ever handed to them. Deltas only reach clients via `DeltaBus`, never `events.append`.

**3 — Coalescing in the runner (best DX for both provider and client).**
`DefaultRunner.callModel` prefers `model.stream()` and buffers `text_delta`s, flushing on whichever comes first: **~50ms** elapsed or **~120 chars**, plus a final flush at turn end. A 500-token answer becomes ~10–20 publishes, not 500 — real-time to the eye, gentle on `NOTIFY`. No timers: the flush check runs on delta arrival (deterministic, easy to test).

**4 — v1 streams assistant text only.** Tool-call argument deltas and reasoning deltas are out of scope; the streaming seam (`ModelStreamEvent`) already has cases for them, so a later sprint can light them up without reshaping anything.

**5 — Multi-instance fan-out is a feature, not a bug.** `pg_notify` broadcasts to **every** listening gateway, so any instance can serve any client's SSE stream with no sticky sessions. The one connection-cost gotcha — a naïve `LISTEN`-per-SSE-client would double DB connections — is avoided by `PgDeltaBus` holding **a single shared `LISTEN` connection per process** and fanning out in memory.

---

## Contracts (see [Type Reference](../specs/05-type-reference.md))

```ts
// @render-factory/store
interface StreamDelta { runId: string; threadId?: string; agentName: string; seq: number; text: string; }
interface DeltaBus {
  publish(delta: StreamDelta): Promise<void>;
  subscribe(filter: { runId?: string; threadId?: string }, signal: AbortSignal): AsyncIterable<StreamDelta>;
}
function createDeltaBus(opts?: { store?: RunStore; pool?: Pool; type?: "memory" | "postgres" }): DeltaBus;

// @render-factory/engine
interface ModelClient {
  complete(args: CompleteArgs): Promise<CompleteResult>;
  stream?(args: CompleteArgs): AsyncGenerator<ModelStreamEvent, CompleteResult>; // now implemented
}
interface RunContext { /* … */ streamDelta(text: string): void; } // fire-and-forget; no-op when no bus
```

`AgentRuntime` gains `readonly deltaBus: DeltaBus`; `createRuntime` builds it (`createDeltaBus({ store })`) and threads it into every in-process run path via `RunInProcessDeps.deltaBus` → `InProcessRunContext`. `streamDelta` serializes publishes on an internal promise tail (ordered) and swallows failures (streaming is best-effort UX; a NOTIFY hiccup never surfaces into the loop).

---

## Gateway SSE merge

`streamRoutes({ store, deltaBus })` merges the durable event tail with the delta subscription into **one** consumer (no concurrent-write hazard on the SSE socket):

- **Durable events** carry SSE `id = seq`, so `Last-Event-ID` reconnects resume exactly (unchanged).
- **`text.delta` frames** carry **no** `id` — they must not move the reconnect cursor. A reconnecting client re-reads durable events from its last seq and skips deltas entirely.
- `/runs/:id/stream` and `/threads/:id/stream` merge deltas (filtered by run / thread); `/events/stream` (operator rail) does **not** — it counts runs/approvals, not assistant text.

---

## UI

`ChatView` accumulates `text.delta` into a transient `streamingText` buffer and renders it live in the in-flight assistant bubble (Markdown), **without** a transcript refetch. When the canonical `message.assistant` for the active run appears on the next refresh, the buffer is dropped and the durable message renders. New turn / send clears it.

---

## Phasing (all landed)

- **Phase 1 — store seam:** `DeltaBus` interface + `StreamDelta`, `MemoryDeltaBus`, `PgDeltaBus` (shared `LISTEN`), `createDeltaBus`; `TRANSIENT_EVENT_TYPES` + append guard (memory + pg). Tests: fan-out/filter, transient-append rejection.
- **Phase 2 — model streaming:** `ModelClient.stream()` for `AnthropicClient` (`messages.stream` → `finalMessage`) and `OpenAIClient` (chunk assembly + `stream_options.include_usage`), factored over a shared `buildBody`.
- **Phase 3 — runner:** `DefaultRunner.callModel` prefers `stream()`, coalesces (50ms/120char), publishes via `ctx.streamDelta`; still emits the same durable `llm.call` + `message.assistant`. Falls back to `complete()` when no `stream()`.
- **Phase 4 — wiring:** `deltaBus` on `AgentRuntime`/`createRuntime`, threaded through `RunInProcessDeps`, `InProcessDispatcher`, `agentTaskHandler`, and the workflow drive paths → `InProcessRunContext`.
- **Phase 5 — gateway SSE:** merge durable tail + delta subscribe; delta frames without `id`. Test: `/runs/:id/stream` surfaces a `text.delta` frame from the bus.
- **Phase 6 — UI:** live delta rendering in `ChatView`, canonical replacement on refresh.

---

## Exit criteria / acceptance

- A streaming-capable model shows assistant text appearing incrementally in the chat UI during a turn; the finished turn renders from the durable `message.assistant` (no double-render, no flicker of lost text).
- `run_events` contains **no** `text.delta` rows for a streamed turn — only the usual `run.started / message.user / llm.call / message.assistant / run.completed`. Attempting to append one throws.
- Deltas coalesce to ~10s of publishes for a multi-hundred-token answer (not one per token).
- A client that connects mid-turn or reconnects resumes durable events from its last `seq` and converges on the canonical message (missed deltas are acceptable, never a correctness issue).
- In `inline` dev (no `DATABASE_URL`), streaming works end-to-end over the in-memory bus with no Postgres.
- A model client **without** `stream()` still runs correctly (blocking `complete()`), emitting no deltas.

---

## Risks / limitations

- **No delta replay.** By design (`NOTIFY` is fire-and-forget). The durable message is the safety net; acceptable because deltas have no historical value.
- **`publish` borrows a pooled connection per flush.** Fine at coalesced volume; if delta throughput ever dominates, a dedicated publish connection (or Redis) is the scale path. Not needed now.
- **Coalescing across multiple model iterations in one turn.** v1 buffers per model call and flushes at each call's end; interleaving text across tool-loop iterations is not separated. Chat turns that stream are typically single-iteration final answers, so this is a non-issue in practice; revisit if multi-iteration streamed text becomes common.
- **Provider stream shape drift.** Anthropic/OpenAI streaming event shapes can change; both adapters reconstruct the *same* `CompleteResult` as `complete()`, so a drift is contained to the adapter (and covered by the fallback path).

---

## Appendix: transient-vs-durable streaming (research)

The event-sourcing literature and production agent frameworks converge on the same split we adopt:

- **Durable = decisions/results; transient = presentation.** Token deltas are a *rendering* of a result that is itself captured once (the assistant message). Persisting the rendering duplicates the fact and inflates the log — the classic "don't event-source your UI frames" guidance.
- **Side-channel streaming.** AG-UI / assistant-stream patterns, and chat products generally, stream tokens over an ephemeral transport (SSE/WebSocket/pub-sub) while persisting only the finalized message. `pg_notify` is the minimal such transport when Postgres is already the backbone.
- **Coalescing.** Sub-frame flushing (tens of ms) is the standard trade between perceived latency and transport/DB pressure; per-token network/DB writes are universally avoided.

This sprint is the smallest implementation of that consensus that fits our seams: one new bus interface, a `stream()` on the model clients, coalescing in the existing runner seam, and an SSE merge — with the log left exactly as durable as before.
