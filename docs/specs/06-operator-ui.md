# Operator UI

**Status:** DRAFT
**Date:** 2026-06-25

**Layer:** L6 — *what you see.* Part of the [render-agents specification](00-foundations.md) ([Document Map](00-foundations.md#document-map)).

A lightweight operator UI for visibility into runs, traces, costs, approvals, and sessions. It is a React + Vite SPA served from the gateway — a read layer over existing API routes and Postgres projections. No new backend routes, no new stores, no new packages.

Each section follows the same shape: **Purpose** (what & why), **Data source** (which gateway route), **Model** (what it shows), and **Interactions** where applicable.

---

## Purpose

The operator UI answers two questions: "what is happening?" and "what needs my attention?" It is for the team operating the agent system — not for end users interacting with agents.

Concretely:

- Inspect any run's full execution trace with cost and token attribution.
- Watch a running agent in real time via the SSE event stream.
- Act on pending HITL approvals without leaving the browser.
- Browse session and thread history to understand multi-turn behavior.
- See aggregate cost at a glance.

The UI is read-only except for approval resolution. It does not edit agent definitions, configure workflows, or serve as an end-user chat interface.

---

## Run list

**Purpose** — The primary landing view. Shows all workflow runs with status, cost, and timing so an operator can quickly find runs that need attention.

**Data source** — `GET /runs` (keyset pagination via `before` cursor).

**Model:**

| Column | Source field | Notes |
|---|---|---|
| Status | `status` | Badge: pending / running / paused / completed / failed / cancelled |
| Workflow | `workflow` | Workflow name |
| Trigger | `trigger` | How the run was initiated (webhook, cron, API, session) |
| Cost | `totalCostUsd` | USD, two decimal places |
| Duration | `finishedAt - startedAt` | Human-readable; "running" if not finished |
| Started | `startedAt` | Relative time ("2m ago") with absolute tooltip |

**Interactions:**

- Filter by workflow name and status.
- Click a row to navigate to [run detail](#run-detail--span-tree).
- Paused runs show a visual indicator linking to the [approvals view](#pending-approvals).

**Cost summary header** — displayed above the run list: total cost, run count, and average cost per run for the currently filtered/visible set. Derived client-side from the loaded `runs` page. This is not a server-side aggregation endpoint.

---

## Run detail / span tree

**Purpose** — The single highest-value view. Shows the full execution trace of one run as a collapsible tree, answering "what happened and what did it cost" at every level.

**Data source** — `GET /runs/:id` (run summary) + `GET /runs/:id/spans` (span tree) + `GET /runs/:id/tool-calls` (tool call input/output, loaded on expand).

**Model** — A collapsible tree mirroring the execution hierarchy. The tree structure follows `SpanRecord.parentId`:

```
workflow run
├── step: prepareDiff
├── agent: security
│   ├── llm: turn 0
│   │   └── tool: github__get_file
│   ├── llm: turn 1
│   └── llm: turn 2 (final)
├── agent: performance (parallel)
│   └── ...
├── agent: judge
│   └── llm: turn 0 (final)
└── step: postReview
```

Each node displays:

| Field | Shown on | Source |
|---|---|---|
| Kind badge | All spans | `kind` (workflow / agent / llm / tool / step) |
| Name | All spans | `name` |
| Status | All spans | `status` (running / ok / error) |
| Duration | All spans | `finishedAt - startedAt` |
| Error | Failed spans | `error` |
| Cost | Agent spans | Sum of child LLM span costs |
| Model | LLM spans | `attributes.model` |
| Input / output tokens | LLM spans | `attributes.inputTokens` / `attributes.outputTokens` |
| Stop reason | LLM spans | `attributes.stopReason` |
| Latency | LLM + tool spans | `attributes.latencyMs` |
| Success / error | Tool spans | `attributes` |

**Interactions:**

- Expand/collapse subtrees. Agent and workflow nodes start expanded; LLM and tool nodes start collapsed.
- Expanding a tool span loads its input/output from the tool-calls endpoint.
- Run header shows: run ID, workflow, status, trigger, total cost, total duration, user ID (if present).
- Per-agent cost breakdown below the header: agent name, model, iteration count, token usage, cost.

---

## Live trace stream

**Purpose** — Real-time visibility into a running agent. The same span tree as run detail, but built incrementally from the SSE event stream so spans appear and update as the run executes.

**Data source** — `GET /runs/:id/stream` (SSE). Events arrive in the [`RunEvent`](05-type-reference.md#runevent) taxonomy.

**Model** — The view renders the same tree layout as run detail. Events drive updates:

| Event | UI effect |
|---|---|
| `run.started` | Initialize the run header |
| `step.started` / `step.completed` | Add/complete step nodes |
| `llm.call` | Add LLM node with token counts and cost |
| `tool.called` / `tool.result` | Add tool node; update with result on completion |
| `message.assistant` | Display assistant message content |
| `text.delta` | Append streaming text to the current assistant message |
| `approval.requested` | Show approval-pending indicator with link to approvals view |
| `subagent.spawned` | Add nested agent subtree |
| `context.compacted` | Show compaction indicator (before/after token counts) |
| `run.completed` / `run.failed` / `run.paused` / `run.cancelled` | Update run header status; stop the stream on terminal states |

**Interactions:**

- Automatic reconnect from last `seq` on disconnect (the gateway SSE contract already supports this).
- Toggle between live stream and static span tree (fetched via `GET /runs/:id/spans`) for completed runs.
- Scroll-to-bottom auto-follow while streaming; pauses on manual scroll-up.

---

## Pending approvals

**Purpose** — The operator's action queue. Shows HITL approval requests that are blocking paused runs, with approve/deny actions.

**Data source** — `GET /approvals` (filtered to `status: pending`). This is the only view with write actions.

**Model:**

| Column | Source field | Notes |
|---|---|---|
| Tool | `toolName` | The gated tool awaiting approval |
| Agent | `agentName` | Which agent requested it |
| Input | `toolInput` | Truncated summary; expandable |
| Requested | `requestedAt` | Relative time |
| Run | `runId` | Link to run detail |

**Interactions:**

- **Approve** — `POST /approvals/:id/resolve` with `{ approved: true }`. The paused run resumes.
- **Deny** — `POST /approvals/:id/resolve` with `{ approved: false, reason }`. Optional reason text field.
- Auto-refresh on a short interval or via SSE (listening for `approval.requested` / `approval.resolved` events on a global stream).
- Resolved approvals drop from the pending list; a separate "resolved" tab shows recent history.

---

## Session / thread browser

**Purpose** — Inspect multi-turn interactions. Shows how users interact with agents over time, with linked runs for each turn.

**Data source** — `GET /sessions/:id/threads` (thread list) + `GET /sessions/:id/threads/:tid/stream` (live thread SSE stream).

**Model:**

**Session list:**

| Column | Source field |
|---|---|
| Session ID | `id` |
| User | `userId` (if present) |
| Last active | `lastActiveAt` |
| Threads | count |

**Thread view:**

- User and assistant turns rendered as a message thread.
- Each assistant turn links to the `runId` that produced it (click-through to run detail). A thread spans a sequence of runs, so consecutive turns may point to different runs after a revival.
- Active threads show a live tail via the thread SSE stream (spans the thread's runs; stays open across a revival under a new run).

**Interactions:**

- Search/filter sessions by user ID.
- Click a session to list its threads.
- Click a thread to view its messages.
- Live indicator on threads with an active (running/paused) run.

---

## Technology

The operator UI is a React + Vite SPA, built as part of `@render-agents/gateway`:

- **Served at** `/ui` (and `/ui/*` for client-side routing). The gateway serves the built SPA assets; all data comes from the existing gateway API routes.
- **Build** — Vite produces a static bundle embedded in the gateway package. No separate deployment.
- **Dependencies** — React, a lightweight tree/table component. No heavy UI framework.
- **SSE** — native `EventSource` (or a reconnecting wrapper) against the existing gateway stream endpoints.

---

## Scope

| In scope | Out of scope |
|---|---|
| Run list with filters and pagination | Dashboards, charts, or timeseries analytics |
| Span tree (static + live SSE) | Agent definition editing or workflow configuration |
| Pending approvals with approve/deny | End-user chat UI |
| Cost summary (per-run, per-agent) | Custom theming or white-labeling |
| Session/thread browser | OAuth connection management UI |
| API key bearer auth (same as gateway) | Role-based access control beyond API key |

---

## Auth

The UI uses the same authentication as the gateway API:

- **API key bearer auth** — the SPA stores the key in memory (entered on first load or passed via query param for dev). All fetch/SSE requests include `Authorization: Bearer <key>`.
- No separate auth flow, no cookies, no user accounts in the UI itself. The API key is the sole gate.
