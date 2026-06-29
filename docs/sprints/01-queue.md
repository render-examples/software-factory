# Sprint 01-Q — Durable Job Queue + Runner Service

**Status:** DRAFT
**Wave:** Post-MVP — Durability & Operability
**Depends on:** 05 (Postgres store + event log + NOTIFY), 11 (Render Workflows dispatch), 12 (`workflow()` + `ctx.step`), 13 (HITL pause/resume)
**Unblocks:** elastic scaling, webhook/cron reliability, root-run crash recovery, durable resume, backpressure/priority

---

## Goal

Decouple **trigger ingestion** from **run execution**. Today every trigger (webhook, HTTP, cron, thread message) calls `workflow.dispatch()`, which emits `run.started` and then runs the entire handler **inline in the gateway request** before returning. This pins the gateway on LLM compute, times out webhook senders and the cron tick, applies no backpressure, and orphans in-flight root runs on a deploy/crash (the event log has `run.started` with no terminal event and nothing re-drives it).

This sprint introduces a **Postgres-backed job queue** (`run_jobs`, claimed via `SELECT … FOR UPDATE SKIP LOCKED`) and a **runner service** that claims and drives root runs and resumes. The gateway becomes a thin front door: emit `run.started`, enqueue, return `202`. Execution, durability, retry, and backpressure move to the runner. Because the event log is already cross-process via `LISTEN/NOTIFY`, SSE streaming and the operator UI keep working unchanged.

---

## Foundational decisions in play

- [D10](../specs/00-foundations.md#d10--the-append-only-event-log-is-the-single-source-of-truth) — the queue stores **pointers, not state**: run identity/input/trigger already live in the `run.started` event; a job row only references the run + what to do with it. No run lifecycle is written outside the log.
- [D4](../specs/00-foundations.md#d4--workflows-orchestrate-postgres-persists) — Workflows orchestrate, Postgres persists. The queue is a new *operational* table (like `schedules`), not a projection; resume stays log-driven.
- [D3](../specs/00-foundations.md#d3--render-workflows-is-per-task-durable-not-deterministic-replay) — root handlers default to `retries: 0`; a handler that emits `run.failed` is terminal and **never auto-retried**. The queue's at-least-once delivery applies only to crash recovery (a run with **no** terminal lifecycle event), reconciled via resume-by-replay.
- [D2](../specs/00-foundations.md#d2--one-execution-model-run-vs-task-is-a-method-call-not-config) / [D8](../specs/00-foundations.md#d8--observable-by-default-every-unit-is-a-span-postgres-is-source-of-truth) — `agent.task()` keeps going through `runtime.dispatcher`; local == production parity is preserved (queue worker with in-process dispatch behaves identically to one with the Render Workflows dispatcher, minus container isolation).

---

## The relationship: control plane vs. compute plane

The queue does **not** replace Render Workflows. They sit at different layers and meet at the existing `TaskDispatcher` seam:

| Concern | Queue + runner (control plane) | Render Workflows (compute plane) |
|---|---|---|
| Trigger ingestion (webhook/http/cron/thread) | **owns** | — |
| Root-run lifecycle + crash recovery | **owns** | — (root `retries: 0`) |
| Durable resume after HITL/input | **owns** | — |
| Backpressure / priority / fairness / provider rate-limit | **owns** | — |
| Works with only Postgres (no Render dependency) | **owns** (fallback) | — |
| Per-agent **isolated** compute (own container) | — | **owns** |
| Per-`plan` compute tiers (`agent@<plan>`) | worker pools (deferred) | **native** |
| Heavy parallel fan-out compute | — | **owns** |
| Managed retries for child work | — | **owns** |

- The queue is the **mailbox** for **root runs and resumes**; Render Workflows is the **isolated executor** for per-agent `agent.task()` work.
- The runner that claims a root job **drives the handler** (I/O-bound: it mostly `await`s child tasks), while heavy LLM compute is offloaded to Render Workflows tasks when present, or runs in-process when not. One runner process can therefore drive **many** concurrent root handlers cheaply.
- Both planes emit to the **same event log** (D10); dispatch-key idempotency already spans in-process and Workflows dispatch, so observability, cost aggregation, and resume stay unified regardless of which plane ran a unit. Root durability = queue; child durability = Workflows; they reconcile through the log.

**Topology fix this enables.** Today the gateway runs root handlers inline, but the gateway web service is **not** a Workflows environment (`RENDER_SDK_SOCKET_PATH` is only set inside a workflow container), so `agent.task()` from a root handler silently falls back to in-process *in the gateway*. Moving root-driving onto a **runner service that is also the Workflows host** makes `agent.task()` genuinely dispatch isolated, plan-tiered tasks. The current scaffolded `worker` (workflow) service and the new queue worker therefore **merge into one runner service**.

```
gateway (web)   → thin: emit run.started + enqueue, return 202
runner (worker) → runWorker() claim loop (roots + resumes)        ← NEW
                  + registers agent@<plan> Workflows handlers      ← EXISTING
postgres        → event log + run_jobs queue
```

---

## Scope

**In:**

- **Schema** — `run_jobs` operational table (migration `0007_run_jobs.sql`, registered in `CORE_MIGRATIONS`). Pointer + minimal payload; partial unique index to prevent duplicate active jobs per run.
- **`JobQueue` interface** in `@render-agents/store` with memory + Postgres implementations (parity-tested), mirroring the `CancelStore` dual-impl pattern.
  - `enqueue(job)`, `claim(workerId)` (FOR UPDATE SKIP LOCKED), `complete(id)`, `fail(id, err, { requeue, backoffMs })`, `reap(staleMs)`, `tail(signal)` (LISTEN/NOTIFY wake on `run_jobs` channel).
- **`runWorker(runtime, opts)`** in `@render-agents/sdk` — the claim loop: bounded concurrency, NOTIFY-driven wake with poll fallback (for delayed/backoff jobs), periodic reaper, routing by `kind`:
  - `workflow` → drive the exported `executeHandler` (the existing function in `workflow.ts`).
  - `agent` → `runAgentInProcess` via `runtime.dispatcher` (so `agent.task()`-style isolation applies).
  - `resume` → `resumeRun(runId, runtime)`.
- **Split `workflow.dispatch()`** — emit `run.started` (as today) then **enqueue** a `workflow` job and return the pending `RunRecord`; export `executeHandler` so the runner can drive it. Gate behind an execution-mode flag (`'inline' | 'queue'`) defaulting to `inline` so existing tests/the no-Postgres path are unchanged.
- **Gateway rewires (no route changes):**
  - `startAgentRun` (`app.ts`) enqueues an `agent` job instead of running inline.
  - `resume`/`driveResume` (`hitl.ts`, `threads.ts`) enqueues a `resume` job — making resume **durable** instead of a detached, restart-losable promise.
  - `runEmbeddedWorker?: boolean` option so `npm run dev` (single process, memory queue) spins an in-process runner loop and keeps today's DX.
- **Cancellation interplay:** the runner checks `cancelStore.isCancelled` before driving a claimed job; a cancel of a still-queued run is honored (job marked done, no execution).
- **Scaffolder/deploy:** `blueprint.ts` `workerEntry()` calls `runWorker(...)`; the `render.yaml` `worker` service repoints to it and is documented as the merged runner (queue loop + Workflows host). Gateway slimmed to enqueue-only.
- **Parity + recovery tests:** memory↔Postgres `JobQueue` parity; SKIP LOCKED concurrency (two claimers get different jobs); crash recovery (claim, don't complete, reap, re-claim) proven idempotent via step memoization + dispatch keys with `mockModel`.

**Out:**

- **Queue-native `agent.task()`** (per-plan worker pools + continuation-style fan-out where a handler unwinds on dispatch and re-drives by replay on child completion). Designed-for but **deferred** — it is "just another `TaskDispatcher`" (`QueueTaskDispatcher`) and can be added later without touching callers. Building it now would reimplement Render Workflows.
- **Per-tenant fairness / weighted scheduling.** `priority` column ships; multi-tenant fairness is a follow-up.
- **Workflow-root resume.** `resumeRun` handles **agent** runs (matching current capability); paused workflow-roots continue to resume via child-task replay as today.
- **Operator UI queue views** (`GET /admin/jobs`, queue-depth metric) — small follow-up once the table exists.
- Any change to `agent.task()` child dispatch semantics (Sprint 11/12 behavior is untouched).

---

## Deliverables

`@render-agents/store`:
- `sql/0007_run_jobs.sql` + registration in `migrations.ts`.
- `job-queue.ts` (`JobQueue` interface), `memory-job-queue.ts` (`MemoryJobQueue`), `pg/job-queue.ts` (`PgJobQueue` with SKIP LOCKED claim + `pg_notify('run_jobs')` + LISTEN tail).
- Exports in `index.ts`; auto-selection in `create-store.ts`.

`@render-agents/sdk`:
- `runtime.jobQueue` wired in `createRuntime` (memory vs pg, mirroring store detection).
- `worker.ts` — `runWorker(runtime, { concurrency, pollMs, staleMs })`.
- `workflow.ts` — split `dispatch()` (enqueue) + exported `executeHandler`; execution-mode flag.

`@render-agents/gateway`:
- `startAgentRun` / `driveResume` enqueue; `runEmbeddedWorker` option.

`create-render-agent`:
- Runner `workerEntry()` + `render.yaml` merge; docs noting Render Workflows is now optional.

---

## Schema + claim query

```sql
-- sql/0007_run_jobs.sql
CREATE TABLE IF NOT EXISTS run_jobs (
    id            TEXT PRIMARY KEY,
    run_id        TEXT NOT NULL REFERENCES runs(id),
    kind          TEXT NOT NULL,                  -- 'workflow' | 'agent' | 'resume'
    status        TEXT NOT NULL DEFAULT 'queued', -- queued|running|done|failed|dead
    priority      INT  NOT NULL DEFAULT 100,      -- lower = sooner (interactive < batch)
    payload       JSONB,                          -- target name, plan, trigger, identity
    attempts      INT  NOT NULL DEFAULT 0,
    max_attempts  INT  NOT NULL DEFAULT 1,        -- workflows: 1 (D3); reaper handles crashes
    available_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    locked_at     TIMESTAMPTZ,
    locked_by     TEXT,
    last_error    TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_run_jobs_claim
    ON run_jobs(status, priority, available_at);
-- One active job per run (prevents double-drive on duplicate enqueue).
CREATE UNIQUE INDEX IF NOT EXISTS idx_run_jobs_run_active
    ON run_jobs(run_id) WHERE status IN ('queued','running');
```

```sql
-- Atomic claim: skip rows locked by other runners.
UPDATE run_jobs SET status='running', locked_at=now(), locked_by=$1,
       attempts=attempts+1, updated_at=now()
WHERE id = (
  SELECT id FROM run_jobs
  WHERE status='queued' AND available_at <= now()
  ORDER BY priority, available_at
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
RETURNING *;
```

---

## Implementation notes

1. **The job is a pointer.** Run identity, input, trigger, and identity already live in the `run.started` event the gateway emits at enqueue. The job row carries only `run_id`, `kind`, `priority`, and a small `payload` (target name + plan + identity) for forward-flex. Nothing in the run lifecycle is written outside the event log (D10).
2. **Reconcile retries with D3.** A job is only reclaimable/retryable when its run has **no terminal lifecycle event** yet. A crash mid-run (no `run.completed/failed/cancelled`) → reaper requeues → resume-by-replay (idempotent via `ctx.step` memoization, dispatch keys, and `appliedToolResult`). A handler that genuinely emitted `run.failed` is terminal — the job is marked done, never retried. So `max_attempts=1` for `workflow` jobs is correct; durability comes from the reaper + replay, not blind re-runs.
3. **Streaming/observability is free.** `events.append` already `pg_notify('run_events', …)` and `tail()` already holds a dedicated `LISTEN` client. A runner in a separate process emitting events streams to gateway SSE clients with no code change. Same for cost aggregation and the operator UI.
4. **Cancellation already crosses processes.** `PgCancelStore` writes `runs.status='cancelled'`; the loop polls it. The runner additionally checks `isCancelled` before driving a claimed job so a queued-but-cancelled run is skipped cleanly.
5. **Runner concurrency is orchestration concurrency, not CPU.** Because a root handler is mostly awaiting child `agent.task()`s (compute offloaded to Workflows or child runs), one runner drives many handlers concurrently. Scale out by adding runner replicas; bound in-flight orchestrations with `concurrency`.
6. **Wake on NOTIFY, poll as fallback.** Reuse the `tail()` LISTEN pattern on a `run_jobs` channel so idle runners claim immediately on enqueue; a low-frequency poll covers delayed/backoff jobs and any missed notification.
7. **Embedded mode preserves DX.** With the memory queue (no `DATABASE_URL`), the gateway runs an in-process runner loop so `npm run dev` is unchanged and tests need no separate process. The execution-mode flag defaults to `inline` until the queue path is proven, then flips to `queue` for the gateway.
8. **Merge worker == Workflows host.** The runner registers the `agent@<plan>` task handlers *and* runs the claim loop, so root handlers it drives have a live Workflows environment and `agent.task()` dispatches real isolated tasks — closing the current gateway-isn't-a-Workflows-env gap.

---

## Phasing

- **Phase 1 — store:** migration + `JobQueue` interface + memory + pg + parity/concurrency/reap tests. Self-contained; no behavior change.
- **Phase 2 — runner:** `runWorker` (claim loop, routing, reaper, backoff) + export `executeHandler`; crash-recovery + idempotent-replay tests with `mockModel`.
- **Phase 3 — wire enqueue:** split `dispatch()`, `startAgentRun`/`driveResume` enqueue, behind the execution-mode flag; gateway embedded-worker for dev; flip default to `queue`.
- **Phase 4 — deploy:** scaffolder runner entrypoint + `render.yaml` merge + docs (Render Workflows now optional).
- **Phase 5 — polish:** `priority` wiring (interactive threads ahead of cron batches), `GET /admin/jobs` + queue-depth for the operator UI.

---

## Exit criteria / acceptance

- A webhook/HTTP/cron/thread trigger returns `202` in milliseconds; the run executes on the runner and is fully observable over the existing SSE stream and projections.
- The cron tick (`/admin/schedules/tick`) enqueues all due schedules and returns immediately, regardless of how many fire.
- Killing the runner mid-run leaves the job reclaimable; the reaper requeues it and another runner drives it **to the same terminal state** (no duplicated side effects), proven via step/dispatch-key replay.
- Resolving an approval / delivering input enqueues a durable `resume` job that survives a gateway restart (no longer a detached promise).
- Two concurrent runners claiming from a backlog never claim the same job (SKIP LOCKED), and never exceed configured `concurrency`.
- `JobQueue` memory↔Postgres parity suite passes.
- With no `DATABASE_URL`, the gateway runs an embedded runner over the memory queue with behavior identical to today (`npm run dev`, tests).
- A run is reconstructable across the gateway→runner process boundary (messages, spans, cost, status) from Postgres.

---

## Risks / open questions

- **Claim throughput / index health:** the partial `idx_run_jobs_claim` must keep the claim query index-only on the hot path; verify under backlog. Consider `available_at` clustering for delayed jobs.
- **Reaper correctness:** the "no terminal event" gate must be evaluated atomically with reclaim to avoid racing a runner that is about to emit a terminal event. Re-check terminal state at claim time before driving.
- **Visibility timeout tuning (`staleMs`):** too short re-drives healthy long runs; too long delays recovery. Make it configurable and longer than the worst-case single-iteration LLM latency (it only bounds *un-acked* progress, not total run time — a healthy runner can heartbeat `locked_at`).
- **Duplicate enqueue:** the partial unique index prevents two active jobs per run; confirm the enqueue path treats a conflict as a benign no-op (idempotent triggers).
- **Embedded-worker shutdown:** the in-process dev runner must drain/abort cleanly on gateway close so tests don't leak loops.
- **Runner == Workflows host packaging:** confirm a single Render deployment can both run the claim loop and register `agent@<plan>` task handlers; if not, split into runner (claim) + workflow-host (compute) and have the runner dispatch via the Render client.
- **When to flip the default to `queue`:** decide whether the gateway defaults to embedded-worker or requires a separate runner in production; document the two supported topologies (single-process dev, gateway+runner prod).
