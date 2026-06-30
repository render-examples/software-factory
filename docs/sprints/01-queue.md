# Sprint 01-Q — Two-Lane Execution: Workflows (durable) + Chat Worker (interactive)

**Status:** DRAFT (re-architected — supersedes the single-lane "queue + runner" plan)
**Wave:** Post-MVP — Durability & Operability
**Depends on:** 05 (Postgres store + event log + NOTIFY), 11 (Render Workflows dispatch), 12 (`workflow()` + `ctx.step`), 13 (HITL pause/resume)
**Unblocks:** webhook/cron reliability, durable pipelines, low-latency chat, HITL that survives deploys

---

## Goal

Decouple **trigger ingestion** from **run execution**, and route each run to the runtime that fits its **workload shape**. Today every trigger (webhook, HTTP, cron, thread message) calls `workflow.dispatch()`, which emits `run.started` and then runs the whole handler **inline in the gateway request**. That pins the gateway on LLM compute, times out webhook/cron callers, applies no backpressure, and (for chat) has no good home at all.

The earlier draft of this sprint solved ingestion with a single Postgres queue + one generic runner that drove **everything** (workflows *and* agents) in-process. Research into Render Workflows ([docs](https://render.com/docs/workflows)) and the `render-agent-harness` reference implementation (its `runtime-web` / `runtime-worker` / `runtime-workflows` split) showed that **one substrate is wrong**: durable pipelines and interactive chat have opposite requirements. So we split execution into **two explicit lanes**:

- **Workflow lane (durable pipelines, batch, scheduled, long HITL).** Render Workflows *is* the queue + worker pool. The gateway records `run.started` and **triggers** a workflow task (`startTask`, fire-and-forget), returning `202`. Render provisions an isolated, plan-tiered container per run, durably, scaling to zero. HITL pauses park and resume **by re-trigger + replay** (a container can deprovision after its 24h cap and the next trigger reconnects via the event log).
- **Chat lane (interactive threads).** A **long-lived worker** drives agent turns from a Postgres queue (`run_jobs`). Each user message is a **new short run (one turn)**, tied to the thread by `threadId`; the warm worker executes it with low latency (no per-message container cold-start), and the gateway streams results over a **persistent SSE connection** that spans turn boundaries. This is the harness's `web + worker` pattern.

The gateway becomes a **front door + stream multiplexer**: it routes each trigger to the right lane and tails the event log to SSE clients. Because the event log is already cross-process via `LISTEN/NOTIFY`, streaming and the operator UI keep working unchanged across both lanes.

---

## Why two lanes (the chat problem)

A workflow can be modeled as a single durable run that parks on HITL and resumes by replay — Render Workflows handles this well. **Chat cannot be modeled the same way:**

- You would **not** re-trigger a workflow per message — every turn would pay container cold-start *plus* replay of the entire growing conversation. Interactive latency dies.
- You also would not hold one workflow container alive for the whole (possibly multi-day) conversation — it is idle 99% of the time and deprovisions at the 24h cap anyway.

The harness resolves this exactly as we now will: **chat turns are cheap jobs on a warm worker**, and **the long-lived connection is an SSE stream held by the web tier** (decoupled from execution, fed by Postgres `LISTEN/NOTIFY`). A conversation is a *sequence of runs* joined by `threadId`; chat-turn-end is **not** a pause. See `render-agent-harness/packages/web/src/routes/conversations.ts` (enqueue per message + a stream that stays open across run boundaries) and `runtime-worker` (warm `pg-boss` consumer).

This means **agent loops run in two places by design**: pipeline/`agent.task()` compute is isolated on **Render Workflows**; interactive chat turns run **in the warm worker** for latency. That is a deliberate split by workload shape, not a compromise.

---

## Foundational decisions in play

- [D10](../specs/00-foundations.md#d10--the-append-only-event-log-is-the-single-source-of-truth) — both lanes write only to the event log; `run_jobs` stores **pointers, not state** (run identity/input/trigger live in `run.started`). Streaming, cost, and resume read the log regardless of lane.
- [D4](../specs/00-foundations.md#d4--workflows-orchestrate-postgres-persists) — Workflows orchestrate, Postgres persists. `run_jobs` is an *operational* table (like `schedules`), used only by the chat lane.
- [D3](../specs/00-foundations.md#d3--render-workflows-is-per-task-durable-not-deterministic-replay) — workflow roots default to `retries: 0`; durability is replay + Render's per-task durability, never blind re-runs. The chat worker's `maxAttempts` is a **delivery/crash-loop budget**, not a logic-retry count.
- [D2](../specs/00-foundations.md#d2--one-execution-model-run-vs-task-is-a-method-call-not-config) — `agent.run()` vs `agent.task()` stays a call-site choice. Within a workflow container, `agent.run()` is in-process and `agent.task()` spawns an isolated child task. The two-lane split is about **roots**, not about this seam.

---

## Architecture

```
                         ┌──────────────────────────────────────────┐
  trigger                │ gateway (web) — front door + SSE multiplex │
  (webhook/http/cron) ──▶│  • append run.started                      │
                         │  • route by lane ↓                         │
  thread message ───────▶│                                            │
                         └───────────────┬───────────────┬───────────┘
                                         │               │
                       WORKFLOW LANE     │               │   CHAT LANE
                       (durable)         │               │   (interactive)
                                         ▼               ▼
                         dispatchRoot → startTask     enqueue run_jobs (agent|resume)
                                         │               │
                                         ▼               ▼
                    ┌─────────────────────────┐   ┌─────────────────────────┐
                    │ Render Workflows host    │   │ chat worker (always-on)  │
                    │  workflow@<plan> task    │   │  runWorker claim loop     │
                    │   → workflowTaskHandler   │   │  drives ONE turn IN-PROC  │
                    │   → wf.drive(runId)       │   │  (warm, low-latency)      │
                    │   agent.task→agent@<plan> │   │  resume = resumeRun()     │
                    │  (Render is the queue)    │   │  parks on HITL            │
                    └────────────┬────────────┘   └────────────┬────────────┘
                                 │                              │
                                 └──────────────┬───────────────┘
                                                ▼
                                   Postgres event log (run_events)
                                   + pg_notify('run_events') ──▶ gateway SSE
```

Three deploy units (mirroring the harness's `web` / `runtime-worker` / `runtime-workflows`):

| Unit | Render service type | Lifetime | Job |
|---|---|---|---|
| **gateway** | web | always-on | ingest, route to lane, hold SSE streams |
| **chat worker** | background worker | always-on | drive interactive agent turns + resumes (warm, in-process) |
| **Workflows host** | workflow service | provisioned per task run (scales to zero) | run `workflow@<plan>` + `agent@<plan>` tasks |

---

## Lane A — Workflows (durable)

**Trigger (gateway).** `workflow.dispatch(input, trigger)` appends `run.started` (`spanKind: "workflow"`) then calls the dispatcher's **root** seam:

```ts
// new on TaskDispatcher
dispatchRoot(job: { workflow: string; runId: string; plan?: RenderPlan }): Promise<void>;
```

- `RenderWorkflowsDispatcher.dispatchRoot` → `client.workflows.startTask("<slug>/workflow@<plan>", [{ workflow, runId }])` — **fire-and-forget** (returns a `taskRunId` immediately; does not block for the run). Uses the REST client (`RENDER_API_KEY`), so it works from the gateway, which is not itself a Workflows container.
- `InProcessDispatcher.dispatchRoot` → `wf.drive(runId)` in-process (dev/test; no Render).

`dispatch()` returns the pending `RunRecord` (status `running`) right after triggering.

**Execute (Workflows host).** The scaffolder registers **one generic task per plan tier** — `workflow@<plan>` — bound to a framework handler the user never writes:

```ts
// runs INSIDE the Render Workflows container; resolves the user's workflow by name
export async function workflowTaskHandler(
  args: { workflow: string; runId: string },     // JSON only — no closures cross runTask
  runtime: AgentRuntime,
  workflows: Map<string, WorkflowDefinition>,
): Promise<void> {
  const wf = workflows.get(args.workflow);
  if (!wf) throw new Error(`no workflow "${args.workflow}" in deployed image`);
  await wf.drive(args.runId);                      // executeHandler runs here; agent.run in-proc, agent.task → child task
}
```

This is the same resolve-by-name pattern as the existing `agentTaskHandler` (definitions are never serialized across `runTask`).

**HITL.** A child parking the handler unwinds as `RunPaused`; `executeHandler` records `run.paused` on the root (already implemented). Resume = the gateway re-`startTask`s the same workflow run; `ctx.step` memoization + deterministic child dispatch keys make the replay idempotent and continue from the pause. The container deprovisioning between pause and resume is fine — the next trigger reconnects via the log.

**No `run_jobs` for workflows.** Render is the durable queue. We accept at-least-once delivery + idempotent tasks (no sweeper); dedupe where it matters comes from deterministic run ids (cron minute-stamp, thread unique index).

---

## Lane B — Chat (interactive)

Keep `run_jobs` + `runWorker`, **scoped to interactive agent turns and resumes** (`kind ∈ {agent, resume}`; the `workflow` kind is removed from the worker — workflows go to Lane A).

**New run per turn (threadId).** Each `POST /threads/:id/messages`:
1. soft sequential-turn guard (one active run per thread; DB partial unique index backstops it);
2. gateway appends `run.started` (`trigger: "thread_message"`, `threadId`) + `message.user`;
3. enqueue a `run_jobs` row (`kind: "agent"`); return `202`.

The conversation is the **set of runs sharing `threadId`**; cross-turn memory loads from prior runs. (This replaces the current "single parked run resumed per message" default, whose replay grows unbounded.)

**Warm in-process execution.** The chat worker drives the turn **in-process** for latency — it does *not* dispatch the root turn to Render Workflows:
- `agent` → `runAgentInProcess(def, run.input, …)` with the run's `runId`/`threadId`/identity.
- `resume` → `resumeRun(runId, runtime)` (HITL within a turn: `awaitInput` / approval).

`agent.task()` *inside* a chat agent still goes through `runtime.dispatcher` (offloaded to Workflows when present) — only the **root turn** runs warm in the worker.

**Streaming.** Unchanged: the worker's `events.append` fires `pg_notify('run_events')`; the gateway's existing SSE routes tail it. The thread/conversation stream stays open across turn boundaries.

**HITL resume routing.** The gateway `resume` closure inspects the paused run: an **agent** root → enqueue a durable `resume` job (chat worker); a **workflow** root → `dispatchRoot` re-trigger (Lane A). (Classify by whether the run's name is in the `workflows` vs `agentDefinitions` registry / `run.started.spanKind`.)

---

## `executionMode` (redefined)

`executionMode` now governs **only the chat lane's topology**:

- `inline` (default; dev/tests, no `DATABASE_URL`): the gateway drives chat turns + resumes **in-process** — no worker, no Render. Workflow `dispatch()` likewise runs inline via `InProcessDispatcher.dispatchRoot`. Single process, today's DX, byte-for-byte unchanged.
- `queue` (production): chat turns/resumes **enqueue** to `run_jobs` for the warm worker; workflow `dispatch()` triggers Render via `RenderWorkflowsDispatcher.dispatchRoot`.

The workflow lane's dev-vs-Render choice is the **dispatcher's** job (auto-detected / injectable), not a second flag.

---

## Developer experience: chat vs pipeline

The author works with **one primitive (agents)** exposed through **two surfaces**. The lane is chosen by *how a thing is invoked*, never by a separate authoring concept.

**Build.**

- *Chat agent* — a markdown agent in `agents/` marked `interactive: true`. No orchestration code:

```markdown
---
description: Conversational assistant for interactive threads
interactive: true
tools: [github]
---
You are a helpful assistant. Hold a multi-turn conversation and answer questions.
```

- *Pipeline* — a `workflow()` in `workflows/<name>/index.ts` composing agents:

```typescript
import { workflow } from "@render-agents/sdk";

export default workflow({ name: "code-review" }, async (ctx) => {
  const diff = ctx.input as string;
  const [sec, perf] = await Promise.all([
    ctx.agents.get("security").task(diff),     // isolated child task (Render Workflows)
    ctx.agents.get("performance").task(diff),
  ]);
  return ctx.step("judge", async () =>
    (await ctx.agents.get("judge").run(`${sec.text}\n\n${perf.text}`)).text,
  );
});
```

**Wire.** One call exposes both surfaces; the author never names a lane:

```typescript
await startGateway({
  runtime, workflows, webhooks, connectors,
  defaultAgent: "assistant",       // → chat surface (threads)
  defaultWorkflow: "code-review",  // → pipeline surface (/workflows)
});
```

**Call.**

- *Chat* — create a thread once, send messages, stream across turns:

```bash
curl -X POST localhost:3000/threads                                   # → { id }
curl -X POST localhost:3000/threads/$ID/messages -d '{"input":"hi"}'  # 202, one turn
curl -N  localhost:3000/threads/$ID/stream                            # SSE, spans turns
```

- *Pipeline* — fire-and-forget, stream/poll the run (also webhooks `POST /webhooks/:name`, cron):

```bash
curl -X POST localhost:3000/workflows/code-review -d '{"input":{"diff":"..."}}'  # → 202 { id }
curl -N  localhost:3000/runs/$RUNID/stream                                       # SSE for this run
```

**What executes where (invisible to the author).**

| | Chat agent | Pipeline |
|---|---|---|
| Authored as | `agents/*.md` (`interactive: true`) | `workflows/*/index.ts` (`workflow()`) |
| Invoked via | `POST /threads/:id/messages` | `POST /workflows/:name`, webhooks, cron |
| Lane | **B** — warm chat worker (in-process turn) | **A** — Render Workflows (`startTask`) |
| Unit of work | one **run per turn**, joined by `threadId` | one durable run; fans out `agent.task()` |
| Memory | thread history across turns | per-run (stateless pipeline) |
| Latency | low (warm) | spin-up per run (durable) |
| HITL | pause → durable `resume` job (worker) | pause → re-trigger + replay (Render) |
| Stream | `GET /threads/:id/stream` (spans turns) | `GET /runs/:id/stream` |

**Behavior change introduced here.** Today `interactive: true` runs as **one long run that parks on `awaitInput`** between messages (`default-runner.ts:149-163`), so replay grows with the conversation. Under the two-lane model chat becomes **new-run-per-turn tied by `threadId`**: `interactive: true` now means "expose this agent as a chat surface," multi-turn memory comes from **thread history** (bounded per-turn replay), and only HITL *within* a turn pauses/resumes (turn-end is not a pause).

The two surfaces compose: a pipeline uses any agent via `ctx.agents`; a chat agent can call tools (later, a tool that triggers a pipeline).

---

## Scope

**In:**

- **`dispatchRoot` seam** on `TaskDispatcher`; `RenderWorkflowsDispatcher.dispatchRoot` (`startTask`, fire-and-forget) + `InProcessDispatcher.dispatchRoot` (in-proc `wf.drive`). Dispatcher gains access to the workflows registry (via runtime) for the inline path.
- **`workflowTaskHandler`** + `workflow@<plan>` task registration (generic, plan-tiered, resolve-by-name) alongside the existing `agentTaskHandler`/`agent@<plan>`.
- **`workflow.dispatch()` rewrite** — append `run.started` then `dispatchRoot(...)` (no `run_jobs`). Return pending `RunRecord`.
- **Chat worker** — `runWorker` retained, routing trimmed to `agent` (drive turn **in-process**) + `resume`; the `workflow` kind is removed. Keep: bounded concurrency, NOTIFY wake + poll, reaper, backoff, D3 resting-state reconciliation, cancellation pre-check.
- **Threads = new run per turn** — `threadRoutes` enqueues an `agent` job per message (Lane B); remove the single-parked-`defaultAgent` resume-per-message default. `startAgentRun` becomes "record opening turn + enqueue (or inline)".
- **HITL resume routing** in the gateway `resume` closure (agent → `resume` job; workflow → `dispatchRoot`).
- **Scaffolder/deploy:** three services in `render.yaml` — gateway (web), **chat-worker** (background worker running `runWorker`), **workflows host** (workflow service registering `workflow@<plan>` + `agent@<plan>`). `blueprint.ts` entrypoints: `src/server.ts` (gateway), `src/worker.ts` (chat worker), `src/workflows.ts` (task host).
- **Tests:** workflow dispatch triggers `startTask` (mocked) and runs inline in dev; chat turn enqueues per message + warm worker drives + SSE spans turns; durable agent resume; workflow resume re-triggers; `JobQueue` memory↔pg parity retained.

**Out:**

- **Queue-native `agent.task()`** (per-plan worker pools / continuation fan-out). Still "just another `TaskDispatcher`"; deferred — Render Workflows already provides it.
- **Per-tenant fairness / weighted scheduling** (chat lane `priority` column ships; fairness later).
- **Soft-checkpoint re-enqueue for very long chat turns** (harness has it; add later if a single turn risks starving the worker). Initial: a turn runs to its resting state.
- **Operator UI queue views** (`GET /admin/jobs`, depth metric) — follow-up.

---

## Schema (chat lane only)

`run_jobs` (migration `0007_run_jobs.sql`, already created) is retained; `kind` is now `'agent' | 'resume'` (drop `'workflow'`). Claim via `FOR UPDATE SKIP LOCKED`; one active job per run via the partial unique index; `pg_notify('run_jobs')` wake. No schema change required beyond the `kind` comment/CHECK.

---

## Phasing

Phases 1–3 of the prior draft built the single-lane queue + generic runner (✅ landed: `run_jobs` schema, `JobQueue` memory+pg with parity/concurrency/reap tests, `runWorker`/`runWorkerLoop`, exported `executeHandler` + `WorkflowDefinition.drive`, `RunPaused`→`run.paused` on roots, `submitRootRun`, queue-mode gateway tests). This re-architecture **reuses** that machinery for the chat lane and adds the workflow lane.

- **Phase 4 — workflow lane:** add `dispatchRoot` + `RenderWorkflowsDispatcher`/`InProcessDispatcher` impls; `workflowTaskHandler` + `workflow@<plan>` registration; rewrite `workflow.dispatch()` to `dispatchRoot` (drop the `workflow` enqueue + `submitRootRun` workflow path). Tests: inline drive (dev) + `startTask` trigger (mocked Render).
- **Phase 5 — chat lane:** trim `runWorker` routing to `agent`(in-process)+`resume`; switch threads to new-run-per-turn enqueue; HITL resume routing; `executionMode` redefinition. Tests: per-turn enqueue, warm drive, SSE across turns, durable resume.
- **Phase 6 — deploy:** three-service `render.yaml` + `blueprint.ts` entrypoints (gateway / chat worker / workflows host) + docs (when to use each lane; chat = worker, pipelines = Workflows).
- **Phase 7 — polish:** `priority` (interactive ahead of batch), optional soft-checkpoint for long turns, `GET /admin/jobs` + depth for the operator UI.

---

## Exit criteria / acceptance

- A webhook/HTTP/cron trigger returns `202` in ms; the workflow runs on Render Workflows and is fully observable over the existing SSE stream + projections (dev: runs inline, identical observability).
- The cron tick enqueues/triggers all due schedules and returns immediately regardless of fan-out.
- A chat thread: each message returns `202` quickly; the warm worker drives the turn with low latency; a single SSE connection streams messages across many turns without reconnecting; a second message while a turn is in flight gets `409`.
- HITL: a paused **workflow** resumes by re-trigger + replay to the same terminal state (no duplicated side effects), surviving container deprovision; a paused **agent/chat** turn resumes via a durable `resume` job surviving a gateway restart.
- Killing the chat worker mid-turn leaves the job reclaimable; the reaper requeues it and another worker drives it to the same terminal state (step/dispatch-key replay).
- With no `DATABASE_URL` (`inline`), gateway runs both lanes in-process with behavior identical to today — no worker, no Render.
- A run is reconstructable across the gateway→(worker|Workflows) boundary (messages, spans, cost, status) from Postgres.

---

## Risks / open questions

- **`startTask` semantics:** confirmed non-blocking (returns `taskRunId`; `runTask` is the blocking variant) per Render docs. The gateway uses `startTask` for roots. Verify the REST client works with only `RENDER_API_KEY` set on the gateway (no in-container socket).
- **Dispatcher selection at the gateway:** root triggering must pick `RenderWorkflowsDispatcher` based on Render config (`RENDER_API_KEY` + `RENDER_WORKFLOW_SLUG`), distinct from `isWorkflowsEnvironment()` (socket) used for in-container child chaining. Reconcile the two detection paths.
- **No idempotency key on `runTask`/`startTask`:** Render does not dedupe triggers. Rely on deterministic run ids + the thread/`run_jobs` unique indexes; design workflow handlers idempotent (they already are, via `ctx.step`). No sweeper.
- **Render Workflows is beta** and `render.yaml` Blueprints may not yet create workflow services (per harness note) — the workflows host may need Dashboard creation; document the deploy checklist.
- **Workflow resume from the gateway:** classifying a paused run as workflow-vs-agent must be reliable (registry lookup / `spanKind`); a misroute would either re-trigger an agent on Render or enqueue a workflow to the chat worker. Add an explicit `root_kind` to the run projection if registry lookup proves ambiguous.
- **Chat worker turn length:** without soft-checkpoint re-enqueue, one very long turn occupies a concurrency slot. Bound with `concurrency` initially; add checkpointing in Phase 7 if needed.

---

## Appendix: Render Workflows — capabilities & constraints (research)

What it provides (so we lean on it instead of rebuilding it):

- **Managed queue + on-demand workers.** Render explicitly positions Workflows as a job-queue replacement: it queues triggered runs, provisions a worker per run within seconds, and **scales to zero** when idle — no always-on fleet to operate.
- **Isolation + tiering.** Each run executes in its **own container**; per-task **compute plans** (`@<plan>`) size CPU/mem. Runs may execute up to **24h**.
- **Automatic retries** per task settings (infra-level), and **chaining** (a task calls other tasks / itself); Render serializes/transports args to child containers — **JSON only, no closures** (hence resolve-by-name handlers).
- **Two trigger primitives:** `startTask` (non-blocking; returns a `taskRunId` immediately — used for **roots**) and `runTask` (blocking; returns the result — used for **awaited children**).

What it does **not** provide (so the control plane owns it):

- **No idempotency keys on triggers.** Duplicate triggers create duplicate runs. We dedupe with **deterministic run ids** + the thread / `run_jobs` partial-unique indexes, and keep handlers idempotent (`ctx.step`). **No sweeper.**
- **No native scheduling.** Cron stays **external** (Render Cron → `POST /admin/schedules/tick`).
- **No per-tenant fairness / priority** (single workspace-level concurrency cap; raise by paying). Fairness, if needed, is the chat lane's `priority` column.
- **No persistent client connection** for chat — that is the gateway's SSE + the warm worker, by design.

Status / caveats:

- **Public beta.** `render.yaml` Blueprints may not yet create workflow services — the Workflows host may need Dashboard creation (document the deploy checklist).
- Gateway triggers via the **REST client** (`RENDER_API_KEY`), distinct from in-container child chaining (`RENDER_SDK_SOCKET_PATH`); the two detection paths must be reconciled.

Sources: [`render.com/docs/workflows`](https://render.com/docs/workflows), [`/workflows-running`](https://render.com/docs/workflows-running), [`/workflows-sdk-typescript`](https://render.com/docs/workflows-sdk-typescript); and the `render-agent-harness` reference (`packages/runtime-workflows`, `runtime-worker`, `web`).
