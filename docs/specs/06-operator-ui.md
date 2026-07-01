# Operator UI

**Status:** IMPLEMENTED (React + Vite SPA served from the gateway at `/ui`)
**Date:** 2026-06-29

**Layer:** L6 — *what you see.* Part of the [render-agents specification](00-foundations.md) ([Document Map](00-foundations.md#document-map)).

A focused operator console for the team running an agent system. It is a React + Vite SPA served from the gateway at `/ui`, and a thin read/act layer over the existing gateway routes and Postgres projections. Its surfaces are grouped by operator intent — **Work**, **Monitor**, **Configure** — spanning five jobs:

1. **Initiate** *(Work)* — start work: converse with an interactive agent from the [chat](#chat--drive-an-interactive-agent) console, dispatch a durable [workflow](#workflows--dispatch-durable-pipelines), or schedule one.
2. **Observe & understand** *(Monitor)* — see what runs exist, what each one did, what it cost, and what it's doing right now.
3. **Debug** *(Monitor)* — drop from the trace tree down to the raw event log, tool I/O, errors, context compaction, and resume state to answer "why did this happen?"
4. **Act** *(Monitor)* — resolve human-in-the-loop approvals (approve / deny / comment), in the context of the run that requested them.
5. **Configure** *(Configure)* — manage OAuth [connections](#connections--oauth-provider-links), [schedules](#schedules--cron-triggered-workflows), and platform [ops](#ops--platform-maintenance) (queue depth, reaper, retention).

Everything the UI shows is a [projection of the event log](00-foundations.md#d10--the-append-only-event-log-is-the-single-source-of-truth) ([D10](00-foundations.md#d10--the-append-only-event-log-is-the-single-source-of-truth)). The UI introduces **no new store and no new stateful concept** — it reads projections and tails the log. The only new backend surface it requires is small and explicitly enumerated in [Backend additions](#backend-additions-required).

Each section follows the same shape: **Purpose** (what & why), **Data source** (which gateway route), **Model** (what it shows), and **Interactions** (what you can do).

---

## Design principles

- **The event log is the model.** Every view is a fold or a tail of `run_events`. The trace tree, the chat transcript, the cost numbers, and the approval queue are all the same data viewed at different grains. The UI never invents state the log doesn't have.
- **One run, many lenses.** A single run is observable as a span tree (structure), an event stream (chronology), a message history (what the model saw), and tool I/O (what it did). Debugging is moving fluidly between these lenses without losing your place.
- **Clean, dense, monospace-friendly.** This is an operator tool, not a marketing surface. High information density, fast filtering, keyboard-navigable, no chrome that doesn't carry data. A light/dark theme that follows the OS, and nothing else.
- **Live by default, static when terminal.** Running and paused runs open an SSE tail; terminal runs render once from projections and skip SSE entirely. The SSE tail is a *notification* channel — an event arriving bumps a `reloadKey` that makes the run's lenses **refetch their projections** (`getRun` / `getSpans` / `getRunEvents`). The UI does **not** fold events incrementally into the tree; live and static share one component because both render from a projection fetch. *(Chat is the one exception — it renders token `text.delta` frames live; see [Chat](#chat--drive-an-interactive-agent).)*
- **Act in context.** Approvals and chat are not separate apps bolted on; they open against the run/thread you're already looking at, so an operator approving a gated tool can see the trace that led there.

---

## Information architecture

A single-pane app with a persistent left rail and a context-aware main area. No nested navigation deeper than two levels. The rail is a **7-section console**, grouped by operator intent into **Work · Monitor · Configure**.

```
┌───────────┬──────────────────────────────────────────────────────────┐
│ WORK      │  ┌────────────────────────────────────────────────────┐  │
│  Chat     │  │  context header: run/thread id · status · cost · ⏱  │  │
│  Workflows│  ├────────────────────────────────────────────────────┤  │
│  Schedules│  │                                                      │  │
│ MONITOR   │  │   main view (chat / runs / trace / approvals / …)    │  │
│  Runs     │  │                                                      │  │
│  Approvals│  │                                                      │  │
│ CONFIGURE │  │                                                      │  │
│  Connect. │  │                                                      │  │
│  Ops      │  └────────────────────────────────────────────────────┘  │
│  ● 3 live │                                                            │
│  ⚠ 2 wait │                                                            │
└───────────┴──────────────────────────────────────────────────────────┘
```

- **Nav** — a single source of truth (`NAV_ITEMS`) drives the rail, command palette, breadcrumb, and router default. The seven sections, by group:
  - **Work** — [Chat](#chat--drive-an-interactive-agent), [Workflows](#workflows--dispatch-durable-pipelines), [Schedules](#schedules--cron-triggered-workflows).
  - **Monitor** — [Runs](#runs--the-monitor-landing), [Approvals](#approvals--approve--deny--comment).
  - **Configure** — [Connections](#connections--oauth-provider-links), [Ops](#ops--platform-maintenance).
- **Default landing = Chat** (`#/chat`). With no hash the app navigates to Chat. The legacy `#/threads` route is an **alias** that rewrites to `#/chat` (there is no standalone Threads section — see [Chat](#chat--drive-an-interactive-agent)).
- **Capability-gated items.** *Connections* is only shown when the gateway has OAuth providers configured (probed once on boot via `GET /connections`); absent that, the item is hidden.
- **Live status footer** — count of active (running/paused) runs and pending approvals, each a link, kept current by the global [`GET /events/stream`](#backend-additions-required) tail. The Approvals item shows a badge when the pending count is > 0.
- **Context header** — whenever a run or thread is selected, a sticky header shows identity, status badge, all-in cost, duration, trigger, and quick actions (cancel, copy id, open raw events).
- **Command palette** (`⌘K`) — jump to a run by id, filter by status/workflow, or open a view. Operator tools live or die on "paste an id, land on the trace."

---

## Runs — the Monitor landing

**Purpose** — The Monitor landing (the app's default is [Chat](#chat--drive-an-interactive-agent), not this). A scannable table of runs so an operator can find what needs attention: failures, paused runs, expensive runs, long-running runs.

**Data source** — `GET /runs` (keyset pagination via `before`). The view sends only `workflow`, `before`, and `limit` to the API. **`status` is never sent** — the status/attention/live filtering is applied **client-side** on the accumulated pages (see Interactions). `GET /runs` defaults `roots=true` (top-level roots only; workflow fan-out / subagent children are hidden unless `roots=false` is passed) — the Runs view never opts in, so it lists roots only.

**Model:**

| Column | Source field | Notes |
|---|---|---|
| Status | `status` | Badge: pending / running / paused / completed / failed / cancelled. Paused rows also carry a **"needs action"** tag. |
| Lane | `threadId` presence | `chat` (Lane B: run carries a `threadId`) vs `workflow` (Lane A: no `threadId`). Chat rows also link "open in chat ↗". |
| Workflow | `workflow` | Workflow or agent name |
| Trigger | `trigger` | webhook / cron / api / thread_message |
| Cost | `totalCostUsd` | This run's cost (USD). Detail view shows the all-in aggregate. |
| Duration | `finishedAt − startedAt` | Human-readable; live ticker if running |
| Started | `startedAt` | Relative ("2m ago") with absolute tooltip |

**Interactions:**

- Filter by workflow (server-side, resets the cursor) and by lane (`all` / `workflow` / `chat`); free-text filter by run id or workflow name. All but the workflow filter are client-side over loaded pages.
- A **status rail** of quick client-side filters: `needs attention` (failed + paused), `live` (running + paused + **pending**), `all`. `needs attention` is the operator's morning view and the default rail selection.
- Click a row → [Run detail](#run-detail--the-trace). **Paused rows carry a "needs action" tag and open the run detail** (approval cards render inline there) — they do **not** deep-link to the Approvals queue.
- **Cost summary strip** above the table: total / count / avg cost computed over the **currently filtered rows** (which may be a subset of the loaded pages). Client-derived — not a server aggregation (none exists, and we don't add one).
- **Virtualization** of the table is *deferred / not yet built*; the table renders the accumulated pages directly with a "Load more" keyset button.

---

## Run detail — the trace

**Purpose** — The single highest-value view: the full execution of one run as a collapsible span tree, answering "what happened, in what order, and what did it cost" at every level. This is where observing becomes debugging.

**Data source** — Loaded upfront (no lazy fetch): `GET /runs/:id` (summary + `aggregateCostUsd`, the all-in cost incl. subagent descendants) + `GET /runs/:id/spans` (tree) + `GET /runs/:id/events` (raw event log) + `GET /runs/:id/children` (cross-run stitch). **Tool I/O comes from the event log** — `tool.called` / `tool.result` events are folded into each tool span; the trace does not call `GET /runs/:id/tool-calls`. *(`GET /runs/:id/tool-calls` exists on the gateway but is currently **unused** by the UI.)*

**Model** — A tree built from `SpanRecord.parentId`, ordered by `seq`:

```
workflow run
├── step: prepareDiff
├── agent: security
│   ├── llm: turn 0           model · in/out tokens · stopReason · cost · latency
│   │   └── tool: github__get_file   input/output (from event log) · ok/error · latency
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
| Model · tokens · stop reason · latency | llm spans | `attributes.model` / `attributes.usage` / `attributes.stopReason` / `attributes.latencyMs` |
| Tool I/O · ok/error · latency | tool spans | tool span `attributes` + `tool.called`/`tool.result` events from the log |

**Cross-run delegation.** A delegating run's children (`agent.task()` / subagents) own their own spans under their own `runId`. The **primary** cross-run stitch is `GET /runs/:id/children`: children are attached under the parent span they hang off (workflow `.task()` / `.run()` fan-out and subagents), recursing into each child's own trace so the operator sees one continuous tree across run boundaries. (`subagent.spawned` events are a fallback link for older runs where the child summary wasn't captured; children whose parent span isn't in this tree are shown at the root rather than dropped.) The all-in cost in the header is `aggregateCostUsd` (the server already walks this).

**Interactions:**

- Expand/collapse; agent + workflow nodes start expanded, llm + tool nodes collapsed.
- Expanding a tool node reveals its `tool.called` input and `tool.result` output (pretty-printed, copyable, error-highlighted), already folded from the event log.
- Header: run id, workflow, status, trigger, all-in cost, this-run cost, duration, user/thread id (each a link), and a **per-agent cost breakdown** rendered as **cost chips** (`agent: $cost`). *(Model / iterations / token counts are not in the header chips — they live on the individual `llm` nodes in the Trace lens.)*
- **Lens switcher** in the header: `Trace` (this view) · `Events` ([log inspector](#event-log-inspector--debug)) · `Messages` ([model view](#message-history--what-the-model-saw)). When the run serves a thread, a separate external **`Chat ↗`** link navigates to the [Chat](#chat--drive-an-interactive-agent) console — Chat is **not** a fourth lens of the run.
- **Cancel** (running/paused) via `POST /runs/:id/cancel` — fires immediately, **no confirmation dialog**.

---

## Live trace stream

**Purpose** — The trace, kept fresh as a run executes. It is the **same component** as Run detail — a live run does not fold events into the tree incrementally; instead the SSE tail acts as a *notification* that triggers a projection **refetch**.

**Data source** — `GET /runs/:id/stream` (SSE), opened only for non-terminal runs (terminal runs render once and skip SSE). Events arrive in the [`RunEvent`](05-type-reference.md#runevent) taxonomy, tagged by [`EventCategory`](05-type-reference.md#eventcategory) (`lifecycle` / `message` / `tool` / `step` / `model` / `approval` / `delegation` / `context`), `id` = `seq`.

**How live works** — Any event on the stream bumps a debounced `reloadKey`. That `reloadKey` re-runs the projection fetches (`getRun` for the header, `getSpans` + `getRunEvents` + `getRunChildren` for the Trace/Events/Messages lenses). The UI reads the *current* projection state rather than mutating a tree per event, so there is **no per-event UI-effect mapping** and **no client-side de-duplication** — a re-render always reflects the durable projection.

**Interactions:**

- Resumable: on disconnect, `EventSource` reconnects and replays `Last-Event-ID` / `?seq=`, so the per-run stream resumes from the last `seq`. Because each event just triggers a refetch, replayed events are harmless (the UI re-reads the projection, it does not accumulate).
- Approvals for the run render inline as cards in the run detail (see [Approvals](#approvals--approve--deny--comment)); resolving one refetches.
- *Deferred / not yet built:* a live-tail vs. static toggle for completed runs, auto-follow of the newest node while streaming, and pause-on-scroll-up. None of these are implemented — live runs simply refetch on the tail, terminal runs render once.
- *Note on `text.delta`:* token-level streaming ships in the [Chat](#chat--drive-an-interactive-agent) console (D13), where deltas render live. The run/trace lenses remain refetch-based and do not fold `text.delta` frames.

---

## Event log inspector — debug

**Purpose** — The raw truth. When the trace tree abstracts away too much, the operator drops to the ordered event log: every `RunEvent`, by `seq`, with category, type, agent, span correlation, and full payload. This is the primary debugging surface — it's the source of truth every other view folds from.

**Data source** — `GET /runs/:id/events` — a direct read of the ordered raw log (the primary source). The per-run SSE replay (`GET /runs/:id/stream` from `seq 0`) is an equivalent alternative that reconstructs the same log; the inspector uses the direct route.

**Model** — A chronological list (**non-virtualized** — virtualization is deferred). Each row shows `seq` · category chip · `type` · a one-line payload summary; expanding a row reveals `ts`, `agentName`, `spanId` / `parentSpanId`, and the full pretty-printed `RunEvent` payload.

**Interactions:**

- Filter by **category** (chips) and **free-text** search across `type` / `agentName` / payload. *(There is no per-`type` filter — deferred / not yet built.)*
- Copy any event as JSON; copy the whole log for a bug report.
- *Deferred / not yet built:* "jump to span" cross-linking into the Trace lens, and visual debug markers for pauses / approvals / compaction / resume boundaries. Neither is implemented — the inspector is a filterable flat log today.

---

## Message history — what the model saw

**Purpose** — Debug prompt/context issues by viewing the exact model-visible history per agent, after context management/compaction — distinct from the human-facing transcript.

**Data source** — folded client-side from the run's event log (`GET /runs/:id/events`, the same fetch the trace and inspector use; the SSE stream is the equivalent live source). `message.user` / `message.assistant` / `message.tool` events become turns; per-agent grouping via `agentName`.

**Model** — Per agent, the ordered turns: user / assistant / tool with `ContentBlock`s rendered (text, plus `tool_use` / `tool_result` blocks pretty-printed). `context.compacted` events render as a divider showing what was summarized (before→after tokens, strategy).

**Interactions:** pick the agent (multi-agent runs show an agent selector). *Deferred / not yet built:* a "show tool_result bodies" toggle and a per-turn copy action.

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

**Context-first resolution.** Resolving in context means the approval card links to (and renders inside) the requesting run's detail: the queue card carries a `run …` link, and the [Run detail](#run-detail--the-trace) view renders that run's pending approval cards inline above the lenses, so the operator decides with the full trace one click away. *(The queue does **not** embed the run's trace inline within each card — context is reached by navigating to run detail.)*

**Interactions:**

- Live updates via the global [`GET /events/stream`](#backend-additions-required) tail (`approval` category): requests appear and resolved items drop out (debounced re-fetch), and the left-rail badge stays current across all runs.
- A **Resolved** tab: recent decisions with who/when/decision/comment. Read via **two queries** (`?status=approved` + `?status=denied`, merged and sorted by `resolvedAt`) — equivalently `?status=all` — from the extended `GET /approvals` route.
- Bulk-safe: each resolve is idempotent; a second resolve of an already-resolved approval is a `409` the UI **surfaces** — an inline error banner on the card plus a toast (not silently swallowed).

---

## Chat — drive an interactive agent

**Purpose** — A first-class chat console for interactive agents (the `interactive` frontmatter flag → a chat surface the warm worker drives one run per turn, [D12](00-foundations.md#d12--two-execution-lanes-durable-workflows-vs-interactive-chat)). Lets an operator converse with an agent, watch it work turn-by-turn, and resolve approvals mid-conversation — the human side of multi-turn, human-in-the-loop work.

**Data source** — threads:

- `POST /threads` — start a conversation (optional `userId`, `title`, `metadata`).
- `POST /threads/:id/messages` — send a turn. The gateway opens a **new run per turn** for the `defaultAgent` (chat lane) or dispatches the `defaultWorkflow` root; multi-turn memory comes from thread-scoped history. A turn delivered while one is generating gets `409 thread_busy`.
- `GET /threads/:id` — thread metadata + transcript (`ThreadMessage[]`).
- `GET /threads/:id/stream` — live SSE spanning the thread's runs (stays open across a revival under a new run).

**Model** — Chat is the app's primary object; the former standalone Threads view is now the **conversation picker** (left pane) with the selected conversation on the right. A chat transcript: user and assistant turns (each assistant turn links to the `runId` that produced it; a thread spans a sequence of runs). A status line reflects the active run: `idle` · `thinking` (running/pending) · `waiting for you` (paused: input) · `needs approval` (pending approval) · `failed`.

**Interactions:**

- Type a message → `POST /threads/:id/messages`. The composer disables **while a turn is thinking** (client-side guard against `409 thread_busy`, which the server also enforces).

  > **Known gap (reconciliation):** the composer is disabled only while `thinking`; it stays **enabled** during `needs approval`, even though the placeholder reads "Resolve the approval above to continue…". A message sent then is rejected server-side (`409`). The spec's intent is to also disable the composer during `needs approval`; today it does not — see `packages/gateway/ui/src/views/ChatView.tsx:254`.

- **Tool/thinking transparency** — chat is not a black box, but it does **not** expand each assistant turn inline into a span tree. Transparency is two affordances: a top-bar **"open trace ↗"** link to [Run detail](#run-detail--the-trace) for the active run (and a per-turn `trace` link on each assistant bubble), plus a live **"using {tool}…"** indicator driven by `tool.called` / `tool.result` events while the turn runs.
- **Approval inside chat** — when a turn is pending approval (status `needs approval`), the approve/deny/comment card appears inline in the transcript (pending approvals for the thread are fetched via `GET /approvals?status=pending&threadId=`); resolving it resumes the conversation in place.
- **Input pause** — when a tool pauses *mid-turn* for human input (status `waiting for you`), the composer re-enables; the next message resumes that run (`message.user` → re-drive). (Ordinary turn-taking is not a pause — each new turn is its own run.)
- **Token streaming (D13)** — the thread stream carries `text.delta` frames scoped to the active run; the in-flight assistant turn renders them live, then converges on the canonical `message.assistant` on the next refetch.
- Live tail via `GET /threads/:id/stream` (EventSource), resumable from `seq`.

> **Scope note.** This is an *operator-facing* console for exercising, observing, and steering agents — not a packaged end-user chat product. It deliberately exposes the machinery (runs, tools, traces, approvals) an end-user UI would hide.

---

## Conversation picker (part of Chat)

> There is **no standalone Threads section.** Multi-turn history is the left pane of [Chat](#chat--drive-an-interactive-agent) — a conversation picker — and the legacy `#/threads` route aliases to `#/chat`.

**Purpose** — Browse, filter, and switch between conversations without leaving the Chat console.

**Data source** — `GET /threads` (optional `?userId=`) for the list; the selected conversation loads via `GET /threads/:id` + `GET /threads/:id/stream` (see [Chat](#chat--drive-an-interactive-agent)).

**Model** — A conversation list (title / id · status badge · last-active relative time), with the active conversation highlighted. The list refreshes on `lifecycle` events from the thread stream.

**Interactions:** filter by `userId`; `+ New` starts a conversation and opens it; click any item to switch the right-hand conversation.

---

## Workflows — dispatch durable pipelines

**Purpose** — *Work.* Start a durable (Lane A) workflow run on demand, and see recent runs for a workflow.

**Data source** — `GET /workflows` (registered workflows + `defaultWorkflow`); `POST /workflows/:name` to dispatch (body `{ input, trigger }`, trigger `"ui"`); `GET /runs?workflow=` for the recent-runs table.

**Model** — A dispatch form (workflow selector + JSON input) and, for the selected workflow, a table of recent runs (status · trigger · cost · duration · started).

**Interactions:** pick a workflow (deep-linkable via `#/workflows/:name`), edit the JSON input, **Dispatch** → navigate to the new run's [detail](#run-detail--the-trace). Invalid JSON is rejected client-side; dispatch failures raise a toast.

---

## Schedules — cron-triggered workflows

**Purpose** — *Work / Configure.* Manage runtime-managed cron schedules and see their last runs.

**Data source** — schedules CRUD routes (`GET /schedules`, `POST /schedules`, `PATCH /schedules/:id`, `DELETE /schedules/:id`, backed by `ScheduleStore`) plus `GET /workflows` to populate the workflow selector, and `POST /workflows/:name` for run-now.

**Model** — id · workflow · cron expression · enabled · last run (link to the run) · last run at.

**Interactions:** **full CRUD** — create, edit (inline form), and delete schedules (delete confirms); enable/disable a schedule; **run now** dispatches the workflow ad-hoc via `POST /workflows/:name` and opens the resulting run. *(This is an upgrade from the earlier "enable/disable only, CRUD optional" scoping — full CRUD is implemented.)*

---

## Connections — OAuth provider links

**Purpose** — *Configure.* Connect and disconnect per-user OAuth providers so agents can act against third-party APIs. This surface is **in scope** (previously listed as out-of-scope "links out at most").

**Data source** — `GET /connections` (optional `?userId=`) lists providers and connection state; `GET /oauth/:provider/authorize` (full-page redirect) starts the consent flow; `DELETE /oauth/:provider?userId=` disconnects. The section (and its nav item) is only present when the gateway has OAuth providers configured.

**Model** — Per provider: name · connected/not-connected · scopes · expiry. The **operator handle** (top bar, persisted in `localStorage`) is used as the OAuth **`userId`**, so connections are scoped per operator.

**Interactions:** **connect** (full-page redirect into the provider's consent screen; the gateway callback stores encrypted tokens), **disconnect**. If no operator handle is set, the view prompts for one first (it is the user id).

---

## Ops — platform maintenance

**Purpose** — *Configure.* An operational surface for the platform's maintenance endpoints — chat-lane queue depth, the stranded-run reaper, and event/run retention.

**Data source** — `GET /admin/jobs` (Lane B chat-queue counts + backlog); `POST /admin/runs/reap` (fail stranded Lane A roots, E6); `POST /admin/retention` (trim old event detail + delete expired run summaries).

**Model** — Chat-queue stat tiles (queued / running / done / failed / dead / backlog) and a maintenance panel with reaper and retention actions.

**Interactions:** run the **reaper**; run **retention** (confirmed, since it deletes). Both report results via toast and refresh the snapshot.

---

## Cross-cutting

### SSE handling

- **Native `EventSource` only.** The API key rides as `?key=` (EventSource can't set headers) — matching the existing dev viewer. REST calls carry `Authorization: Bearer <key>`; there is **no** fetch-based SSE reader with an `Authorization` header.
- **Per-run / per-thread streams honor `Last-Event-ID` / `?seq=`** on reconnect. The UI does **not** de-dupe by `seq` — each event triggers a projection refetch (see [Live trace](#live-trace-stream)), so replays are idempotent by construction. The thread stream **stays open across turns** (it spans the thread's sequence of runs and does not close when one run reaches a terminal state).
- One stream per open run/thread, plus a single app-wide **global tail** ([`GET /events/stream`](#backend-additions-required)) that lives for the session and feeds the rail counters (folding `lifecycle` and `approval` events into debounced count refetches).

  > **Known gap (reconciliation):** the global `GET /events/stream` is **forward-only** — it does not replay the log on connect (it opens `tail({})` with no catch-up read). Rail counts (active runs, pending approvals) can therefore be stale until the next REST refresh (boot fetch or a subsequent event); events emitted before the tail connects are not reflected by the stream alone — see `packages/gateway/src/routes/stream.ts:83`.

### Performance

- **Virtualization is deferred / not yet built** for the run table, the event log, and span trees — they render their loaded rows directly. (The dep for it was intentionally omitted; see [Technology](#technology).)
- Child (subagent) span subtrees are stitched from `GET /runs/:id/children`; tool I/O is folded from the event log rather than lazily fetched.
- Client-side keyset pagination for `GET /runs` via `before` ("Load more").

### Technology

- React + Vite SPA, built as part of `@render-agents/gateway`, served at `/ui` (+ `/ui/*` for client routing). Vite emits a static bundle embedded in the gateway package; no separate deploy.
- Lightweight deps only: **React + Tailwind CSS 4 + `react-markdown`**. **No virtualization library**, no heavy UI framework, and no state-management library beyond React + a tiny store. Keep the bundle small (it ships inside the gateway).
- The pure, browser-safe trace helpers already shipped for the dev viewer (`buildSpanTree`, `flattenTree`, `perAgentCost`, `formatCost`, `formatDuration`) are reused as the tree/cost core, so the logic stays unit-testable outside the DOM.

---

## Auth

Same gate as the gateway API — **API key bearer auth**, no separate auth system:

- The SPA shell loads unauthenticated; the operator enters the key on first load. The key is stored in **`sessionStorage`**, with a **`?key=` query fallback** (used in dev and for SSE `EventSource`). REST requests carry `Authorization: Bearer <key>`; SSE carries the key via `?key=`.
- **Operator identity for the audit trail.** `resolve`/`input` accept a `resolvedBy`. Since the only gate is a shared API key, the UI prompts once for an operator name/handle — persisted in **`localStorage`** so it survives across tabs — and sends it as `resolvedBy` on every decision. The same operator handle doubles as the **OAuth `userId`** for [Connections](#connections--oauth-provider-links). This is a display/audit convenience, not an access-control boundary — RBAC beyond the API key is out of scope.

---

## Scope

| In scope | Out of scope |
|---|---|
| Run list with filters, "needs attention", cost strip | Server-side dashboards, charts, timeseries analytics |
| Trace tree (static + live-refetch), per-agent cost, cross-run stitching | Agent definition editing / workflow configuration |
| Event log inspector + message-history (model view) lenses | An end-user (white-labeled) chat product |
| Approvals queue with approve / deny / comment, in context | Role-based access control beyond the API key |
| Interactive **chat** console + conversation history (Chat sidebar), tool/trace transparency | Editing/replaying past events (the log is append-only) |
| **Workflows** dispatch + **Ops** (queue / reaper / retention) | Multi-tenant org/team management |
| **OAuth connection management UI** (Connections view) | Cookies / user accounts / SSO |
| Schedules **full CRUD** + run-now | |
| API-key bearer auth + `resolvedBy` operator handle | |

---

## Backend additions required

The UI is overwhelmingly a read/act layer over **existing** routes. Three small, additive, event-log-consistent changes were made to the gateway (no new store, all backward-compatible):

1. **`GET /events/stream`** *(new route).* A **global** SSE tail of the event log — the same `EventLogStore.tail` mechanism the per-run/per-thread streams already use, but unfiltered (`tail({}, signal)`). It backs the live approvals badge and the cross-run "live" footer, which need a system-wide tail rather than one stream per run. Emits the same `EventCategory`-tagged events; unlike the per-run stream, `data` carries the full record (incl. `runId`) so events can be attributed to a run. The UI subscribes once and folds `approval.*` and `run.*` events into the rail counters (debounced re-fetch).

2. **`GET /runs/:id/events`** *(new route, convenience).* A direct read of the ordered event log for the [Event log inspector](#event-log-inspector--debug) and the [Messages lens](#message-history--what-the-model-saw). Reconstructable from the per-run SSE replay otherwise, so it's an ergonomic shortcut, not a capability gap.

3. **`GET /approvals?status=`** *(extended route).* The approvals route now accepts `?status=pending|approved|denied|all` (default `pending`, unchanged) and returns the resolution fields (`status`, `resolvedBy`, `resolvedAt`, `reason`). This powers the [Resolved tab](#approvals--approve--deny--comment). Backed by the store's existing `listApprovals({ status })`.

Everything else — runs, spans, tool-calls, per-run/thread streams, threads, schedules, cancel, resolve — is served by the gateway as-is. **Comments need no backend change**: an approval comment is the resolve `reason`, persisted on the `approval.resolved` event and folded onto the `ApprovalRequest` projection.

### UI-support endpoints (existing routes the UI leans on)

Beyond the three additions above, the shipped UI depends on these existing gateway routes:

- **`GET /runs/:id/children`** — child runs (workflow `.task()` / `.run()` fan-out + subagents), the primary cross-run stitch for the [Trace](#run-detail--the-trace).
- **`GET /workflows`** — registered workflows + `defaultWorkflow`, backing the [Workflows](#workflows--dispatch-durable-pipelines) dispatch form and the workflow selectors in [Schedules](#schedules--cron-triggered-workflows).
- **`GET /connections`** (+ `GET /oauth/:provider/authorize`, `DELETE /oauth/:provider`) — OAuth provider state and connect/disconnect for [Connections](#connections--oauth-provider-links); also probed on boot to gate the nav item.
- **`GET /admin/jobs`**, **`POST /admin/runs/reap`**, **`POST /admin/retention`** — the [Ops](#ops--platform-maintenance) maintenance surface.
- **`GET /approvals?threadId=`** — thread-scoped pending approvals rendered inline in [Chat](#chat--drive-an-interactive-agent).

**Build & serving.** The SPA lives in `packages/gateway/ui/` (React + Vite), builds to `packages/gateway/dist/ui-app/` via `vite build` (wired into the package `build` script ahead of the server `tsc`), and is served by `src/routes/ui.ts` — the shell + hashed assets unauthenticated under `/ui`, with an SPA fallback for client routes. It ships inside the published gateway package (`files: ["dist"]`); no separate deployment.

---

## Resolved decisions

- **Global live updates → `GET /events/stream`.** The live footer/approvals badge use a single global event tail (above), not polling.
- **Comment = note on approve/deny.** "Comment" is the `reason` attached to a resolution; there is no standalone "annotate without resolving." No `operator.note` event is added.
- **Per-operator auth is later.** v1 ships a self-entered operator handle sent as `resolvedBy` for the audit trail; real per-operator identity/RBAC is deferred.
- **Token streaming shipped in Chat (D13); other lenses refetch.** The [Chat](#chat--drive-an-interactive-agent) console renders token-level `text.delta` frames live and converges on the canonical `message.assistant` on refetch. The run/trace/messages lenses remain **projection-refetch-based** (an SSE event triggers a re-read, not incremental event folding) — so `text.delta` is not a "future upgrade" wholesale; it is live in Chat and deliberately not folded into the trace lenses.
