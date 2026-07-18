# Track G — Durable orchestration patterns

> De-risks: spec §6.3 (idempotent, handle-not-block delegation), §7.2 (DAG execution), §11.1 (Workflows mapping).

## Question

What durable-execution patterns should the Migration/Slice Orchestrators follow so long-running, fan-out, retryable DAG execution is correct?
- Idempotency (the `slice_id:attempt` key, §6.3) and exactly-once effects.
- Determinism constraints in durable workflows (what can/can't run inside a task).
- Handle-not-block / async run patterns for up-to-24h tasks (`run_id`, `status_url`, `await_run`, `cancel_run`).
- Retry/timeout/backoff and failure isolation ("a failed slice does not poison siblings", §7.2).
- Concurrency-budget/rate-limit coordination (Key Value, §11.1).

## Why it's load-bearing

The DAG's correctness under retries, parallel fan-out, and container teardown depends on getting durable-execution semantics right. Mistakes here cause duplicate runs, lost state, or corrupted merges.

## Sources to review

- Render Workflows docs (authoritative for our platform semantics).
- **Temporal**, **Restate**, **Inngest** — durable execution: idempotency, determinism, signals, retries, saga patterns (conceptual transfer even if we don't use them).
- **Local:** `agent-workflows-template/` and `render-agents/` for concrete Workflows usage patterns.

## Findings

### 0. The load-bearing distinction: Render Workflows is *per-task durable*, not *deterministic-replay*

This is the single most important finding and it reframes everything below. There are two families of durable-execution engines:

- **Deterministic-replay** (Temporal, Restate, Inngest): the orchestration function is re-executed from the top on every recovery; the engine replays a journal/event-history, skipping already-completed steps and re-injecting their recorded results. Correctness *requires* the handler be deterministic (no wall-clock, randomness, unrecorded external reads). Side effects go in Activities / `step.run` / `ctx.run`. Refs: [Temporal determinism](https://docs.temporal.io/workflow-definition), [Restate journaling](https://docs.restate.dev/foundations/key-concepts), [Inngest steps](https://www.inngest.com/docs/learn/how-functions-are-executed).
- **Per-task durable** (Render Workflows): each *task run* is the durable unit. Render manages queuing, isolated per-run containers, retries, and timeouts, but on retry it **re-runs the whole task function from scratch** — there is no built-in journal that memoizes mid-task steps, and no deterministic-replay engine. Refs: [Intro to Render Workflows](https://render.com/docs/workflows), [Defining Tasks](https://render.com/docs/workflows-defining), [Durability as code](https://render.com/blog/durability-as-code-introducing-render-workflows).

**Consequence for us:** Render gives us durable *orchestration plumbing* (queue, isolated compute, retries, timeouts, chaining, fan-out) but the *exactly-once / replay-idempotency / signals / saga* semantics that Temporal-style engines bundle are **our responsibility to build on Postgres + Key Value.** The local `render-agents` repo has already built exactly this layer and is our best blueprint — it explicitly names this decision "D3: Render Workflows is per-task durable, not deterministic replay" (`render-agents/docs/sprints/00-mvp/complete/12-workflows-determinism.md:18`, `render-agents/docs/specs/02-execution.md:115-128`).

---

### 1. What Render Workflows provides *natively*

Confirmed from Render docs and mirrored by local usage:

| Capability | Native behavior | Source |
| --- | --- | --- |
| **Durable task + isolated compute** | Each task run gets its own on-demand container, spun up in seconds, deprovisioned on completion, scales to zero. | [docs/workflows](https://render.com/docs/workflows) |
| **Chaining (DAG edges)** | A task calls another task's function → chained run in its own container; parent awaits children. `parent_task_run_id` / `root_task_run_id` correlate the chain. | [docs/workflows](https://render.com/docs/workflows), Python SDK dump `…/agent-tools/…:661` |
| **Parallel fan-out** | Trigger many child tasks concurrently with ordinary language primitives (`Promise.all` / `asyncio.gather`); Render schedules/provisions hundreds of containers. | [blog](https://render.com/blog/durability-as-code-introducing-render-workflows); local `render-agents/examples/demo/workflows/pr-review/index.ts:56-61` (4-way `.task()` fan-out) |
| **Retries + backoff** | Per-task `retry: { maxRetries, waitDurationMs, backoffScaling }`; default 3 retries / 4 attempts, exponential. A run "fails" if the function throws or times out. | [workflows-defining](https://render.com/docs/workflows-defining), [SDK TS](https://render.com/docs/workflows-sdk-typescript) |
| **Timeouts up to 24h** | `timeoutSeconds` 30s–86400s, default 2h. Directly satisfies spec §6.3's "up to 24h". | [SDK TS](https://render.com/docs/workflows-sdk-typescript) |
| **Handle-not-block trigger** | `startTask()` returns a handle (`taskRunId` + initial `status`) immediately; `runTask()` blocks to completion; `get_task_run()` / `taskRunEvents()` poll/stream status; `cancelTaskRun()` cancels a *running* run. | [workflows-running](https://render.com/docs/workflows-running.md), Python SDK dump `…:317-445` |
| **Managed queue + coarse concurrency cap** | Render queues runs and enforces a **workspace-level max concurrent task runs** (raise for a monthly fee); excess runs queue. | [docs/workflows](https://render.com/docs/workflows) |
| **Per-task compute plan** | `plan: starter…pro_ultra` per task — lets us right-size Implementer vs. Researcher. | [SDK TS](https://render.com/docs/workflows-sdk-typescript); local `RenderWorkflowsDispatcher` maps `agent@<plan>` `render-agents/packages/sdk/src/dispatch.ts:201-217` |

This maps cleanly onto spec §6.3's `trigger_task → { run_id, status_url, queued }` contract: `startTask` **is** the handle-not-block trigger (`run_id = taskRunId`), `get_run_status`/`await_run`/`cancel_run` are `get_task_run`/`runTask`(or `.get()`)/`cancel_task_run`.

### 1a. Native gotchas that bite the DAG

- **`AbortSignal` ≠ cancel.** Passing an `AbortSignal` to `startTask`/`runTask` only aborts the *client-side wait/HTTP call*; "Runs continue executing on Render." Real cancellation is `cancelTaskRun(taskRunId)`, and it only works while the run is *running* (errors otherwise). ([SDK TS](https://render.com/docs/workflows-sdk-typescript), Python dump `…:432`).
- **`Promise.all` fan-out fails fast.** The reference `pr-review` fan-out uses `Promise.all` (`render-agents/examples/demo/workflows/pr-review/index.ts:56`), which rejects on the *first* child failure. That directly violates spec §7.2 "a failed slice does not poison siblings." For the migration DAG we must use `Promise.allSettled` (or per-slice try/catch) so one slice failure is isolated.
- **Retry re-runs the entire task.** Because there's no mid-task journal, any non-idempotent side effect before the failure point re-executes on retry. Idempotency is *ours* to guarantee (see §2).
- **Blueprints can't yet manage Workflow services.** `render.yaml` provisions web+Postgres+KV+crons, but the Workflow service must be created manually in the Dashboard (`render-agents/render.yaml:7-24`, `agent-workflows-template/README.md:256-259`). Affects the "one Blueprint" goal (spec §11.2) — flag for Track that owns packaging.

---

### 2. What we must implement (and how the local repos already do it)

#### 2.1 Idempotency / exactly-once effects — **build on Postgres**

Render does not dedupe triggers or memoize steps; "idempotency is managed by the developer within the task logic." The proven local pattern (`render-agents`):

- **Deterministic keys, not random ids.** Child run ids are derived, not `randomUUID`: `idempotencyKey(parentRunId, "task:<name>:<ordinal>")` = `SHA-256(parentRunId \0 suffix)` (`render-agents/packages/store/src/idempotency.ts:13`, `render-agents/packages/sdk/src/workflow.ts:440,473`; dispatch key `computeDispatchKey(runId, agentName, callSeq)` `…/dispatch.ts:30`). This is exactly the spec's `slice_id:attempt` idea (§6.3) — a re-trigger/replay recomputes the *same* key, so it addresses the *same* child run instead of spawning a duplicate.
- **Idempotency = one event-log lookup.** "Has this already run?" is answered by a single lookup against the append-only log, not a separate dedupe store (D10; `…/idempotency.ts:6-11`, `render-agents/docs/…/13-hitl-idempotency-cancellation.md:34`).
- **Memoized child output.** A child that already reached `completed` returns its stored result instead of re-dispatching (`memoizedChildOutput`, `render-agents/packages/sdk/src/workflow.ts:502-513`; in-process via reserved `__task_output__` step `…/dispatch.ts:143-150`).
- **DB-enforced single-flight.** The Postgres job queue has a **partial unique index** `ON run_jobs(run_id) WHERE status IN ('queued','running')` so a duplicate trigger is a no-op INSERT and two workers can't double-drive one run (`render-agents/packages/store/sql/0007_run_jobs.sql:41-42`, `…/pg/job-queue.ts:126-149`). This is the concrete Postgres analog of the spec's `slice_id:attempt` idempotency key.
- **External-trigger dedupe via state machine.** `issue-to-pr` re-reads GitHub labels and refuses to act if `agent:working`/`agent:done` is present (`render-agents/examples/demo/workflows/issue-to-pr/index.ts:88-90`) — the same technique we'll use with **slice status in Postgres** as the DAG's dedupe gate (advance a slice only if its status permits).

Conceptual transfer: Temporal auto-dedupes Updates by Update ID but requires *you* to key Signals and make Activities idempotent ([Temporal messages](https://docs.temporal.io/handling-messages)); Restate dedupes on an **idempotency key header** ([Restate concepts](https://docs.restate.dev/foundations/key-concepts)); Inngest collapses event bursts with a function-level **idempotency** key ([Inngest flow control](https://www.inngest.com/docs/guides/flow-control)). All three converge on the same rule we adopt: **stable key + record-once side effects.**

#### 2.2 Determinism constraints — **inside a task, replay-safe or memoized**

Since Render re-runs whole tasks, our own orchestrator handler (`render-agents`' `workflow()` layer) adds a Temporal-style contract *in application code*:

- `retries: 0` on the root orchestrator handler by default — durability comes from child task runs + event-log replay, **not** blind re-runs of the handler (`render-agents/packages/sdk/src/workflow.ts:76,92-95`; D3).
- Side effects must live in **`ctx.step(name, fn)`** (memoized by `(runId, name)` via `step.started`/`step.completed` events) or in **`agent.task()`** (deterministic child id). On re-drive, completed steps short-circuit to the stored result (`…/workflow.ts:243-345`).
- Control flow must be **stable** because step names and fan-out `callSeq` ordinals are positional — a branch on wall-clock/random would shift ordinals and break replay (`render-agents/docs/…/12-workflows-determinism.md:64`, `02-execution.md:115-128`).
- Task boundaries require JSON-serializable I/O (`assertSerializable`, `…/dispatch.ts:38-47`).

For the migration DAG this means: **the DAG topology and slice-advancement logic must be a pure function of persisted state (Postgres), never of in-memory or wall-clock state.** The orchestrator reads DAG state from Postgres, decides "what's ready," and dispatches — so a crashed/re-driven orchestrator recomputes the identical decisions.

#### 2.3 Handle-not-block / async up-to-24h — **native trigger + our polling/resume**

`startTask` already gives the non-blocking handle. What Render does **not** yet provide is native **pause/resume / signals / wait-for-event** (it's on the roadmap — "Pause and resume workflows", "Checkpoint state" [blog](https://render.com/blog/durability-as-code-introducing-render-workflows)). Local confirmation: `NativeWorkflowsSuspender.park()` throws "not yet available" and is not selected by the runtime (`render-agents/packages/sdk/src/native-suspender.ts:24-31`, `render-agents/docs/sprints/native-pause-resume.md:1-12`). Until it ships:

- **Resume-by-replay** is the pattern: to resume a parked run, re-trigger it and let `ctx.step`/child-run memoization fast-forward to the pause point (D7; `render-agents/docs/…/13-hitl-idempotency-cancellation.md:31,67`).
- A human-gate (spec §7.2 integration/e2e gates, §11.1 review gates) is modeled as `run.paused` + a pending-input record, resumed by appending a resolve event and re-driving.
- Because a parked/awaited run can silently die (host accepted the trigger but never progressed), we need a **stranded-run reaper** cron: `reapRuns` fails runs with >15min of silence, and dispatch is **fail-fast** (records `run.failed` if `dispatchRoot` throws) so a run is never stuck `running` forever (`render-agents/packages/store/src/retention.ts:24-36`, `render-agents/packages/sdk/src/workflow.ts:137-158`, `render-agents/render.yaml:96-114` reaper cron).

#### 2.4 Retry / timeout / backoff / failure isolation

- Use **native per-task** `retry` + `timeoutSeconds` for transient/infra failures (the cheap, correct default).
- Distinguish **retryable vs terminal** failures the way Restate/Temporal sagas do: retry transient errors; a *business* failure (e.g. slice can't reach parity) should be a **terminal** outcome that triggers compensation/human-gate, not infinite retry ([Restate sagas](https://docs.restate.dev/guides/sagas), [Temporal saga](https://docs.temporal.io/design-patterns/saga-pattern)).
- **Isolation is on us:** fan out with `Promise.allSettled`, record each slice's outcome to Postgres independently, and let the orchestrator treat a failed slice as an isolated, retryable node whose siblings proceed (spec §7.2). The `run_jobs` **visibility-timeout reaper** (`reap(staleMs)` requeues jobs whose worker crashed, `…/pg/job-queue.ts:203-218`, `…/worker.ts:287-292`) is the sibling-safe crash-recovery mechanism.

#### 2.5 Saga / compensation (transitional shims + merges)

Spec §4/§7.2 introduce transitional shims and branch merges at DAG join points — these are distributed side effects that can partially fail, i.e. classic saga territory. Adopt the cross-engine consensus:

- Register a **compensation before** each risky forward action (so cleanup runs even if the forward action failed mid-flight), run compensations in **reverse order**, and make every compensation **idempotent and no-op-safe** ([Temporal saga](https://docs.temporal.io/design-patterns/saga-pattern), [Restate sagas](https://docs.restate.dev/guides/sagas)). Concretely: a slice that opens a shim/branch registers "remove shim / delete branch" compensation keyed by `slice_id` before mutating; on terminal failure the orchestrator runs it.

#### 2.6 Concurrency budgeting / rate-limiting — **build in Key Value**

Render's only native concurrency control is the **coarse, workspace-wide** max-concurrent-runs cap (buyable, not per-role/per-migration) — insufficient for spec §11.1's "concurrency budget" and cost control across large fan-outs. Inngest shows the target shape (per-key concurrency, throttling, rate-limit, priority scopes — [Inngest flow control](https://www.inngest.com/docs/guides/flow-control)); Restate uses virtual-object single-writer per key as a lock ([Restate services](https://docs.restate.dev/foundations/services)). We must implement in **Key Value (Redis-compatible)** per spec §11.1:

- **Concurrency budget:** a per-migration (and optionally per-role: Implementer/Validator) counter/semaphore in KV; the trigger tool checks budget before `startTask` and surfaces `queued: true` when saturated (matches the `trigger_task → { queued }` return, §6.3).
- **Transient locks:** KV locks for cross-slice coordination (e.g. serializing merges at a DAG join point) — the spec's "KV locks" (§11.1). Note the local repos currently coordinate via **Postgres** (`FOR UPDATE SKIP LOCKED` + advisory locks, `…/pg/job-queue.ts:152-168`, `…/sql/0003_run_events.sql:27-39`), *not* KV — so KV budgeting/locks are net-new work for us.
- **Rate-limit** LLM/provider calls to avoid hammering APIs during big fan-outs (spec §13 cost/concurrency risk).

---

### 3. Native-vs-ours summary table

| Semantic | Render Workflows native | We must implement |
| --- | --- | --- |
| Isolated durable compute per node | ✅ | — |
| DAG chaining + parallel fan-out | ✅ (`Promise.all`/`gather`) | Sibling isolation via `allSettled` + per-slice status |
| Per-task retries/backoff/timeout (≤24h) | ✅ | Retryable-vs-terminal classification |
| Handle-not-block trigger (`run_id`/status/cancel) | ✅ (`startTask`/`get_task_run`/`cancel_task_run`) | Thin MCP/tool wrapper + `run_id ↔ DAG node` in Postgres (§6.3) |
| Exactly-once effects / idempotency keys | ❌ (dev's job) | Deterministic keys + event-log dedupe + `run_jobs` unique index (Postgres) |
| Deterministic replay / step memoization | ❌ (whole-task re-run) | `ctx.step` memoization + `retries:0` handler + stable control flow |
| Pause/resume / signals / wait-for-event | ❌ (roadmap) | Resume-by-replay + `run.paused` records + stranded-run reaper |
| Saga / compensation | ❌ | App-level compensations (register-before, reverse, idempotent) |
| Fine-grained concurrency budget / rate limit / locks | ⚠️ coarse workspace cap only | KV semaphores + locks + rate limiters |
| Stranded-run detection | ❌ | Reaper cron + fail-fast dispatch |

## Recommendation

1. **Treat Render Workflows as durable plumbing, and port `render-agents`' durability layer wholesale.** It already implements, tested, every "we must implement" row above (deterministic child ids, event-log idempotency, `ctx.step` memoization, `run_jobs` single-flight queue, cooperative cancel, reaper, fail-fast dispatch). Do **not** reinvent — adapt it to slices/DAG. Primary references: `render-agents/packages/sdk/src/{workflow,dispatch,worker}.ts`, `render-agents/packages/store/src/{idempotency,pg/job-queue,retention,cancel-store}.ts`, and the design notes in `render-agents/docs/…/{12,13}-*.md`.

2. **Idempotency key = `slice_id:attempt`, realized two ways:** (a) as the deterministic child `run_id` (`SHA-256(migration_id \0 slice_id:attempt)`) so re-triggers/replays are self-deduping, and (b) as a Postgres uniqueness constraint on the `TaskRun` table (spec §12) — the partial-unique-index pattern from `run_jobs`. Persist `run_id ↔ DAG node` for §6.3 correlation and dashboard.

3. **Make the Migration Orchestrator a pure function of Postgres DAG state** (`retries: 0`, side effects in `ctx.step`/child tasks). "What slices are ready?" is recomputed from persisted slice statuses on every (re-)drive, so a crash/retry is safe. Slice status is the dedupe gate (issue-to-pr label pattern).

4. **Fan out with `Promise.allSettled`, never `Promise.all`,** and record each slice result independently so a failed slice is isolated and retryable (spec §7.2). Classify failures: transient → native retry; terminal (no parity) → human gate / compensation.

5. **Build concurrency budgeting + transient locks in Key Value now** (per-migration and per-role semaphores, provider rate limiting, merge locks). This is genuinely net-new vs. the local repos (which use Postgres coordination) and is required for §11.1 cost/concurrency control. Have the `trigger_task` tool consult the budget and return `queued: true` when saturated.

6. **Ship the operational safety nets from day one:** a stranded-run reaper cron (§2.3) and fail-fast dispatch, plus cooperative cancellation with `cancelScopeId` cascade so cancelling a migration/slice cleanly stops descendant tasks (`render-agents/packages/sdk/src/workflow.ts:442,467`, `…/worker.ts`).

7. **Design the human/integration gates as resume-by-replay** for now; keep a thin `Suspender`-style seam (`render-agents/packages/sdk/src/native-suspender.ts`) so we can swap to Render's native pause/resume when it GAs without reworking callers.

## Open items

- **[Resolved] Native vs. ours:** Render natively provides isolated durable compute, chaining/fan-out, retries/backoff, ≤24h timeouts, handle-not-block trigger + status + cancel, and a coarse workspace concurrency cap. We must implement idempotency/exactly-once, deterministic replay/step-memoization, pause-resume/signals, saga/compensation, and fine-grained concurrency budgeting/locks — all on Postgres + Key Value. (See §3 table.)
- **KV vs. Postgres for coordination:** local repos coordinate via Postgres (`FOR UPDATE SKIP LOCKED` + advisory locks), but spec §11.1 assigns budgeting/locks to Key Value. Decide the split — recommend KV for hot concurrency budgeting/rate-limiting, Postgres for the durable `TaskRun`/DAG record; confirm we don't need both to agree transactionally (avoid split-brain on the budget).
- **Native pause/resume timing:** Render's pause/resume + checkpoint features are roadmap. Track GA; until then we own resume-by-replay + reaper. Keep the `Suspender` seam.
- **Concurrency cap economics:** the native max-concurrent-runs cap is workspace-wide and paid; large migrations may need a high cap *plus* our KV budget to sub-allocate fairly across concurrent migrations/roles. Validate cost model against spec §13.
- **Cancellation depth:** confirm `cancelTaskRun` semantics for a *chain* (does cancelling a parent cascade to in-flight children, or only the parent?). Local code assumes cooperative cascade via `cancelScopeId` polling because platform cascade is unconfirmed — verify with a spike (ties into Track A).
- **Blueprint limitation:** Workflow services can't be created via `render.yaml` yet (must be manual in Dashboard), which dents the "single Blueprint fork-and-deploy" goal (spec §11.2) — hand to the packaging track.
- **Determinism guardrails:** there's no runtime guard against a non-deterministic orchestrator handler; rely on the `ctx.step` discipline + docs + optional dev-mode lint for `Date.now()`/`Math.random()` in handler frames (`render-agents/docs/…/12-workflows-determinism.md:81`).
