# Operator UI

**Status:** IMPLEMENTED (React + Vite SPA served from the gateway at `/ui`)
**Date:** 2026-06-29

**Layer:** L6 — *what you see.* Part of the [render-agents specification](00-foundations.md) ([Document Map](00-foundations.md#document-map)).

A focused operator console for the team running an agent system. It is a React + Vite SPA served from the gateway at `/ui`, and a thin read/act layer over the existing gateway routes and Postgres projections. It does three jobs, in priority order:

1. **Observe & understand** — see what runs exist, what each one did, what it cost, and what it's doing right now.
2. **Debug** — drop from the trace tree down to the raw event log, tool I/O, errors, context compaction, and resume state to answer "why did this happen?"
3. **Act** — resolve human-in-the-loop approvals (approve / deny / comment) and drive interactive agents from a chat console.

Everything the UI shows is a [projection of the event log](00-foundations.md#d10--the-append-only-event-log-is-the-single-source-of-truth) ([D10](00-foundations.md#d10--the-append-only-event-log-is-the-single-source-of-truth)). The UI introduces **no new store and no new stateful concept** — it reads projections and tails the log. The only new backend surface it requires is small and explicitly enumerated in [Backend additions](#backend-additions-required).

Each section follows the same shape: **Purpose** (what & why), **Data source** (which gateway route), **Model** (what it shows), and **Interactions** (what you can do).

---

## Design principles

- **The event log is the model.** Every view is a fold or a tail of `run_events`. The trace tree, the chat transcript, the cost numbers, and the approval queue are all the same data viewed at different grains. The UI never invents state the log doesn't have.
- **One run, many lenses.** A single run is observable as a span tree (structure), an event stream (chronology), a message history (what the model saw), and tool I/O (what it did). Debugging is moving fluidly between these lenses without losing your place.
- **Clean, dense, monospace-friendly.** This is an operator tool, not a marketing surface. High information density, fast filtering, keyboard-navigable, no chrome that doesn't carry data. A light/dark theme that follows the OS, and nothing else.
- **Live by default, static when terminal.** Running and paused runs auto-follow the SSE tail; terminal runs render once from projections. The same component renders both — live is just "the same tree, updated by events."
- **Act in context.** Approvals and chat are not separate apps bolted on; they open against the run/thread you're already looking at, so an operator approving a gated tool can see the trace that led there.

---

## Information architecture

A single-pane app with a persistent left rail and a context-aware main area. No nested navigation deeper than two levels.

```
┌───────────┬──────────────────────────────────────────────────────────┐
│           │  ┌────────────────────────────────────────────────────┐  │
│  Runs     │  │  context header: run/thread id · status · cost · ⏱  │  │
│  Approvals│  ├────────────────────────────────────────────────────┤  │
│  Chat     │  │                                                      │  │
│  Threads  │  │   main view (trace / events / chat / approvals)      │  │
│  Schedules│  │                                                      │  │
│           │  │                                                      │  │
│  ─────────│  │                                                      │  │
│  ● 3 live │  └────────────────────────────────────────────────────┘  │
│  ⚠ 2 wait │                                                            │
└───────────┴──────────────────────────────────────────────────────────┘
```

- **Left rail** — the five surfaces (Runs, Approvals, Chat, Threads, Schedules) plus a live status footer: count of active (running/paused) runs and pending approvals, each a link, kept current by the global [`GET /events/stream`](#backend-additions-required) tail. The Approvals item shows a badge when the pending count is > 0.
- **Context header** — whenever a run or thread is selected, a sticky header shows identity, status badge, all-in cost, duration, trigger, and quick actions (cancel, copy id, open raw events).
- **Command palette** (`⌘K`) — jump to a run by id, filter by status/workflow, or open a view. Operator tools live or die on "paste an id, land on the trace."

---

## Runs — the observe landing

**Purpose** — The default view. A scannable table of runs so an operator can find what needs attention: failures, paused runs, expensive runs, long-running runs.

**Data source** — `GET /runs` (keyset pagination via `before`; filters `workflow`, `status`, `limit`).

**Model:**

| Column | Source field | Notes |
|---|---|---|
| Status | `status` | Badge: pending / running / paused / completed / failed / cancelled |
| Workflow | `workflow` | Workflow or agent name |
| Trigger | `trigger` | webhook / cron / api / thread_message |
| Cost | `totalCostUsd` | This run's cost (USD). Detail view shows the all-in aggregate. |
| Duration | `finishedAt − startedAt` | Human-readable; live ticker if running |
| Started | `startedAt` | Relative ("2m ago") with absolute tooltip |

**Interactions:**

- Filter by workflow and status; free-text filter by run id.
- A **status rail** of quick filters: `needs attention` (failed + paused), `live` (running + paused), `all`. `needs attention` is the operator's morning view.
- Click a row → [Run detail](#run-detail--the-trace). Paused-for-approval rows show a ⚠ that deep-links straight to the [approval](#approvals--approve--deny--comment).
- **Cost summary strip** above the table: total / count / avg cost for the loaded page. Client-derived from the page — not a server aggregation (none exists, and we don't add one).

---

## Run detail — the trace

**Purpose** — The single highest-value view: the full execution of one run as a collapsible span tree, answering "what happened, in what order, and what did it cost" at every level. This is where observing becomes debugging.

**Data source** — `GET /runs/:id` (summary + `aggregateCostUsd`, the all-in cost incl. subagent descendants) + `GET /runs/:id/spans` (tree) + `GET /runs/:id/tool-calls` (tool I/O, lazy on expand).

**Model** — A tree built from `SpanRecord.parentId`, ordered by `seq`:

```
workflow run
├── step: prepareDiff
├── agent: security
│   ├── llm: turn 0           model · in/out tokens · stopReason · cost · latency
│   │   └── tool: github__get_file   input/output (lazy) · ok/error · latency
│   ├── llm: turn 1
│   └── llm: turn 2 (final)
├── agent: performance (parallel)
│   └── …
└── step: postReview
```

Per node:

| Field | Shown on | Source |
|---|---|---|
| Kind badge | all | `kind` (workflow / agent / llm / tool / step) |
| Name | all | `name` |
| Status | all | `status` (running / ok / error) |
| Duration | all | `finishedAt − startedAt` |
| Error | failed spans | `error` (inline, expandable) |
| Cost | agent spans | sum of descendant `llm` span `attributes.costUsd` |
| Model · tokens · stop reason · latency | llm spans | `attributes` (incl. `gen_ai.*` aliases) |
| Tool I/O · ok/error · latency | tool spans | `attributes` + `/tool-calls` payloads |

**Cross-run delegation.** A delegating run's children (`agent.task()` / subagents) own their own spans under their own `runId`. The tree stitches them in by following `subagent.spawned.childRunId` — expanding a `subagent` node lazily fetches the child run's spans and grafts its subtree, so the operator sees one continuous tree across run boundaries. The all-in cost in the header is `aggregateCostUsd` (the server already walks this).

**Interactions:**

- Expand/collapse; agent + workflow nodes start expanded, llm + tool nodes collapsed.
- Expanding a tool node loads its `tool.called` input and `tool.result` output (pretty-printed, copyable, error-highlighted).
- Header: run id, workflow, status, trigger, all-in cost, duration, user/thread id (each a link), and a **per-agent cost breakdown** (agent · model · iterations · tokens · cost).
- **Lens switcher** in the header: `Trace` (this view) · `Events` ([log inspector](#event-log-inspector--debug)) · `Messages` ([model view](#message-history--what-the-model-saw)) · `Chat` (if the run serves a thread). Same run, different lens, shared selection.
- **Cancel** (running/paused) via `POST /runs/:id/cancel`, with a confirm.

---

## Live trace stream

**Purpose** — The trace, but built incrementally as a run executes. Same component as Run detail; events drive the updates.

**Data source** — `GET /runs/:id/stream` (SSE). Events arrive in the [`RunEvent`](05-type-reference.md#runevent) taxonomy, tagged by [`EventCategory`](05-type-reference.md#eventcategory) (`lifecycle` / `message` / `tool` / `step` / `model` / `approval` / `delegation` / `context`), `id` = `seq`.

| Event | UI effect |
|---|---|
| `run.started` | seed header + root span (`spanKind` → workflow/agent root) |
| `step.started` / `step.completed` | add / close step nodes |
| `llm.call` | add llm node with tokens, cost, stop reason, latency |
| `tool.called` / `tool.result` | add tool node; fill result on completion |
| `message.assistant` | render assistant message content |
| `text.delta` | append streaming text to the live assistant message (when token streaming lands; today the stream emits whole `message.assistant`) |
| `approval.requested` | mark the run paused-for-approval; surface an inline **approve/deny/comment** affordance |
| `approval.resolved` | clear the pending marker, show the decision + comment |
| `subagent.spawned` | add a `subagent` node ready to expand into the child run |
| `context.compacted` | show a compaction marker (before→after tokens, strategy) |
| `run.completed` / `failed` / `paused` / `cancelled` | update header; stop the tail on terminal states |

**Interactions:**

- Resumable: on disconnect, reconnect from the last `seq` (the SSE contract honors `Last-Event-ID` / `?seq=`); no gaps, no dupes.
- Toggle live-tail vs static `GET /runs/:id/spans` for completed runs.
- Auto-follow newest while streaming; pause-follow on manual scroll-up.

---

## Event log inspector — debug

**Purpose** — The raw truth. When the trace tree abstracts away too much, the operator drops to the ordered event log: every `RunEvent`, by `seq`, with category, type, agent, span correlation, and full payload. This is the primary debugging surface — it's the source of truth every other view folds from.

**Data source** — `GET /runs/:id/stream` replays the full log from `seq 0` on connect (catch-up before tailing), so the inspector reconstructs the complete log without a new route. (An explicit `GET /runs/:id/events` is a small, optional convenience — see [Backend additions](#backend-additions-required).)

**Model** — A virtualized, chronological list. Each row: `seq` · `ts` · category chip · `type` · `agentName` · one-line payload summary; expand for the full pretty-printed `RunEvent` payload and `spanId`/`parentSpanId`.

**Interactions:**

- Filter by category and by `type`; free-text search across payloads.
- "Jump to span" from an event → highlights the node in the Trace lens (and back).
- Copy any event as JSON; copy the whole log for a bug report.
- Visual markers for the load-bearing debug moments: pauses, approval request/resolve, compaction, errors, cancellations, resume boundaries (the first replayed event after a `run.paused`).

---

## Message history — what the model saw

**Purpose** — Debug prompt/context issues by viewing the exact model-visible history per agent, after context management/compaction — distinct from the human-facing transcript.

**Data source** — folded client-side from the `message`/`tool` events already streamed for the run (no extra route). Per-agent grouping via `agentName` on the events; mirrors `getMessages(runId, agentName)`.

**Model** — Per agent, the ordered `Message[]`: user / assistant / tool turns with `ContentBlock`s rendered (text, `tool_use` with input, `tool_result` with output/`isError`). `context.compacted` events render as a divider showing what was summarized (before→after tokens).

**Interactions:** pick the agent (for multi-agent runs); toggle "show tool_result bodies"; copy a turn.

---

## Approvals — approve / deny / comment

**Purpose** — The operator's action queue. HITL approval requests that are blocking paused runs, resolved in context with a decision and a comment.

**Data source** — `GET /approvals` (pending) for the queue; `POST /approvals/:id/resolve` for the decision; the global/run SSE stream (`approval` category) to keep it live.

**Model:**

| Field | Source | Notes |
|---|---|---|
| Tool | `toolName` | the gated tool awaiting approval |
| Agent | `agentName` | which agent requested it |
| Input | `input` | truncated summary; expandable to full tool input |
| Requested | `requestedAt` | relative time |
| Run | `runId` | link to the trace at the requesting node |

**The approve / deny / comment interaction.** Each pending item is a card with three affordances:

- **Approve** — `POST /approvals/:id/resolve` `{ approved: true, resolvedBy, reason? }`. The paused run is re-driven (resume-by-replay) and continues. `resolvedBy` is the operator identity (see [Auth](#auth)).
- **Deny** — `POST /approvals/:id/resolve` `{ approved: false, resolvedBy, reason? }`. The denial flows back to the loop as an error `tool_result`; the agent proceeds with the denial in context.
- **Comment** — a free-text note attached to the decision via the resolve `reason` field, persisted on the `approval.resolved` event and folded onto the `ApprovalRequest` projection — so an approve-with-note and a deny-with-reason are both first-class and show in the audit trail. "Comment" always means "the note you attach when you approve or deny"; there is no standalone annotate-without-resolving, and so no backend change is needed (see [Resolved decisions](#resolved-decisions)).

**Context-first resolution.** Opening an approval shows the requesting run's trace inline (the path down to the gated `tool.called`) so the operator decides with full context, not from a bare tool name + JSON blob.

**Interactions:**

- Live updates via the global [`GET /events/stream`](#backend-additions-required) tail (`approval` category): requests appear and resolved items drop out without a refresh, and the left-rail badge stays current across all runs.
- A **Resolved** tab: recent decisions with who/when/decision/comment, read from `GET /approvals` history (any status).
- Bulk-safe: each resolve is idempotent; a second resolve of an already-resolved approval is a no-op `409` the UI surfaces gracefully.

---

## Chat — drive an interactive agent

**Purpose** — A first-class chat console for interactive agents (the `interactive` frontmatter flag → a chat surface the warm worker drives one run per turn, [D12](00-foundations.md#d12--two-execution-lanes-durable-workflows-vs-interactive-chat)). Lets an operator converse with an agent, watch it work turn-by-turn, and resolve approvals mid-conversation — the human side of multi-turn, human-in-the-loop work.

**Data source** — threads:

- `POST /threads` — start a conversation (optional `userId`, `title`, `metadata`).
- `POST /threads/:id/messages` — send a turn. The gateway opens a **new run per turn** for the `defaultAgent` (chat lane) or dispatches the `defaultWorkflow` root; multi-turn memory comes from thread-scoped history. A turn delivered while one is generating gets `409 thread_busy`.
- `GET /threads/:id` — thread metadata + transcript (`ThreadMessage[]`).
- `GET /threads/:id/stream` — live SSE spanning the thread's runs (stays open across a revival under a new run).

**Model** — A chat transcript: user and assistant turns (each assistant turn links to the `runId` that produced it; a thread spans a sequence of runs). A status line reflects the active run: `idle` · `thinking` (running) · `waiting for you` (paused: input) · `needs approval` (paused: approval) · `failed`.

**Interactions:**

- Type a message → `POST /threads/:id/messages`. The composer disables while a turn is mid-flight (`running`/`pending` → `409 thread_busy` is prevented client-side, enforced server-side).
- **Tool/thinking transparency** — assistant turns expand inline to reveal the tool calls and llm steps of their run (the same span data as the trace), so chat isn't a black box. "Open full trace" jumps to [Run detail](#run-detail--the-trace) for that turn's run.
- **Approval inside chat** — when a turn pauses for approval (status `needs approval`), the approve/deny/comment card appears inline in the transcript; resolving it (via the approvals API) resumes the conversation in place.
- **Input pause** — when a tool pauses *mid-turn* for human input (status `waiting for you`), the composer re-enables; the next message resumes that run (`message.user` → re-drive). (Ordinary turn-taking is not a pause — each new turn is its own run.)
- Live tail via `GET /threads/:id/stream`, resumable from `seq`.

> **Scope note.** This is an *operator-facing* console for exercising, observing, and steering agents — not a packaged end-user chat product. It deliberately exposes the machinery (runs, tools, traces, approvals) an end-user UI would hide.

---

## Threads — multi-turn history

**Purpose** — Browse and inspect conversations over time, independent of the live Chat console.

**Data source** — `GET /threads` (optional `?userId=`) + `GET /threads/:id` + `GET /threads/:id/stream`.

**Model** — Thread list (id · user · title · status · last active) and a thread view (transcript with each assistant turn linking to its `runId`; live tail for active threads).

**Interactions:** filter by `userId`; click into a thread (read-only history, or hand off to the Chat console if active); a live indicator on threads with a running/paused run.

---

## Schedules — operability (optional, low priority)

**Purpose** — Visibility into runtime-managed cron schedules and their last runs. Included because it's a pure read over an existing store and rounds out "what is this system doing."

**Data source** — schedules CRUD routes (`GET /schedules`, etc., backed by `ScheduleStore`).

**Model** — id · workflow · cron expression · enabled · last run (link to the run) · last run at.

**Interactions:** enable/disable a schedule; trigger its workflow ad-hoc via `POST /workflows/:name`. CRUD beyond enable/disable is optional and can be deferred.

---

## Cross-cutting

### SSE handling

- Native `EventSource` (or a small reconnecting wrapper). The API key rides as `?key=` for `EventSource` (which can't set headers) — matching the existing dev viewer — or via a fetch-based SSE reader with `Authorization`.
- Resume from `seq` on every reconnect (`Last-Event-ID` / `?seq=`). Catch-up replay then live tail; the UI de-dupes by `seq`.
- One stream per open run/thread, plus a single app-wide global tail ([`GET /events/stream`](#backend-additions-required)) that lives for the session and feeds the rail counters. Per-run/thread streams close on terminal states and on view change. A debounced re-render coalesces event bursts.

### Performance

- Virtualize the run table, the event log, and large span trees.
- Lazy-load tool I/O and child (subagent) span subtrees on expand only.
- Client-side keyset pagination for `GET /runs` via `before`.

### Technology

- React + Vite SPA, built as part of `@render-agents/gateway`, served at `/ui` (+ `/ui/*` for client routing). Vite emits a static bundle embedded in the gateway package; no separate deploy.
- Lightweight deps only: React, a virtualization helper, a tree/table primitive. No heavy UI framework, no state-management library beyond React + a tiny store. Keep the bundle small (it ships inside the gateway).
- The pure, browser-safe trace helpers already shipped for the dev viewer (`buildSpanTree`, `flattenTree`, `perAgentCost`, `formatCost`, `formatDuration`) are reused as the tree/cost core, so the logic stays unit-testable outside the DOM.

---

## Auth

Same gate as the gateway API — **API key bearer auth**, no separate auth system:

- The SPA shell loads unauthenticated; the operator enters the key on first load (stored in memory / `sessionStorage`, or passed via `?key=` in dev). All fetch/SSE requests carry `Authorization: Bearer <key>` (SSE via `?key=`).
- **Operator identity for the audit trail.** `resolve`/`input` accept a `resolvedBy`. Since the only gate is a shared API key, the UI prompts once for an operator name/handle and sends it as `resolvedBy` on every decision, so approvals carry *who* decided, not just *that* it was decided. This is a display/audit convenience, not an access-control boundary — RBAC beyond the API key is out of scope.

---

## Scope

| In scope | Out of scope |
|---|---|
| Run list with filters, "needs attention", cost strip | Server-side dashboards, charts, timeseries analytics |
| Trace tree (static + live), per-agent cost, cross-run stitching | Agent definition editing / workflow configuration |
| Event log inspector + message-history (model view) lenses | An end-user (white-labeled) chat product |
| Approvals queue with approve / deny / comment, in context | Role-based access control beyond the API key |
| Interactive **chat** console (threads), tool/trace transparency | OAuth connection management UI (links out at most) |
| Thread history browser | Editing/replaying past events (the log is append-only) |
| Schedules read + enable/disable (optional) | Multi-tenant org/team management |
| API-key bearer auth + `resolvedBy` operator handle | Cookies / user accounts / SSO |

---

## Backend additions required

The UI is overwhelmingly a read/act layer over **existing** routes. Three small, additive, event-log-consistent changes were made to the gateway (no new store, all backward-compatible):

1. **`GET /events/stream`** *(new route).* A **global** SSE tail of the event log — the same `EventLogStore.tail` mechanism the per-run/per-thread streams already use, but unfiltered (`tail({}, signal)`). It backs the live approvals badge and the cross-run "live" footer, which need a system-wide tail rather than one stream per run. Emits the same `EventCategory`-tagged events; unlike the per-run stream, `data` carries the full record (incl. `runId`) so events can be attributed to a run. The UI subscribes once and folds `approval.*` and `run.*` events into the rail counters (debounced re-fetch).

2. **`GET /runs/:id/events`** *(new route, convenience).* A direct read of the ordered event log for the [Event log inspector](#event-log-inspector--debug) and the [Messages lens](#message-history--what-the-model-saw). Reconstructable from the per-run SSE replay otherwise, so it's an ergonomic shortcut, not a capability gap.

3. **`GET /approvals?status=`** *(extended route).* The approvals route now accepts `?status=pending|approved|denied|all` (default `pending`, unchanged) and returns the resolution fields (`status`, `resolvedBy`, `resolvedAt`, `reason`). This powers the [Resolved tab](#approvals--approve--deny--comment). Backed by the store's existing `listApprovals({ status })`.

Everything else — runs, spans, tool-calls, per-run/thread streams, threads, schedules, cancel, resolve — is served by the gateway as-is. **Comments need no backend change**: an approval comment is the resolve `reason`, persisted on the `approval.resolved` event and folded onto the `ApprovalRequest` projection.

**Build & serving.** The SPA lives in `packages/gateway/ui/` (React + Vite), builds to `packages/gateway/dist/ui-app/` via `vite build` (wired into the package `build` script ahead of the server `tsc`), and is served by `src/routes/ui.ts` — the shell + hashed assets unauthenticated under `/ui`, with an SPA fallback for client routes. It ships inside the published gateway package (`files: ["dist"]`); no separate deployment.

---

## Resolved decisions

- **Global live updates → `GET /events/stream`.** The live footer/approvals badge use a single global event tail (above), not polling.
- **Comment = note on approve/deny.** "Comment" is the `reason` attached to a resolution; there is no standalone "annotate without resolving." No `operator.note` event is added.
- **Per-operator auth is later.** v1 ships a self-entered operator handle sent as `resolvedBy` for the audit trail; real per-operator identity/RBAC is deferred.
- **Per-message assistant text is acceptable.** The UI renders whole `message.assistant` turns; token-level `text.delta` streaming is a transparent future upgrade, not a v1 requirement.
