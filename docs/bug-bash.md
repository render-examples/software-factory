# Bug Bash — implementation gaps surfaced by spec reconciliation

**Status:** PROPOSED (triage needed)
**Date:** 2026-07-01
**Source:** Surfaced while reconciling `docs/specs/*` against the implementation. Each item is a place where the **code diverges from a foundational decision or a documented contract** — not cosmetic spec drift (that was folded into the specs directly).

Each bug is also flagged inline in the relevant spec as a `> **Known gap (reconciliation):**` note. This doc is the single triage surface; fixing a bug should remove its spec note.

---

## Triage table

| ID | Severity | Area | One-line | Contradicts |
|---|---|---|---|---|
| [BUG-01](#bug-01--cancel-store-not-auto-wired-to-postgres) | High | Execution / control plane | `POST /runs/:id/cancel` silently no-ops in default Postgres deploys | D10 |
| [BUG-02](#bug-02--hook-veto-crashes-the-run) | High | Execution / hooks | A gate hook `reject` crashes the run instead of a recoverable error `tool_result` | D9 |
| [BUG-03](#bug-03--scaffolder-gateway-missing-execution-mode-queue) | High | Deploy / scaffolder | Gateway runs chat inline while a paid chat-worker sits idle | D12 |
| [BUG-04](#bug-04--scaffolder-gateway-missing-render-workflows-trigger-env) | High | Deploy / scaffolder | Gateway drives workflow roots in-process; workflows worker unused | D12 |
| [BUG-05](#bug-05--workflows-host-entrypoint-is-a-stub) | Medium | Deploy / scaffolder | Workflows host registers no tasks (stub) | D12 |
| [BUG-06](#bug-06--scaffolder-render-yaml-hardcodes-npm) | Low | Deploy / scaffolder | `render.yaml` always uses `npm` regardless of chosen package manager | — |
| [BUG-07](#bug-07--thread--global-sse-streams-unreliable-on-reconnect) | Medium | Platform / SSE | Thread/global SSE reconnect misses events; `seq` ids collide across runs | D10 (SSE projection) |
| [BUG-08](#bug-08--threadcurrentrunid-never-populated) | Low | Platform / threads | `Thread.currentRunId` exists on the type but is never set by the server | — |
| [BUG-09](#bug-09--requireapproval-on-subagents-fails-load-validation) | Medium | Authoring / HITL | `requireApproval: [subagents__x]` fails load validation even when declared | D6 |
| [BUG-10](#bug-10--mcp-tool-namespace-ignores-directory-name) | Medium | Authoring / tools | MCP tools namespace as `mcp__*` (not `<dir>__*`) when `name` omitted | D6 |
| [BUG-11](#bug-11--chat-composer-enabled-during-needs-approval) | Low | Operator UI | Chat composer stays enabled during `needs approval`; server 409s the message | — |
| [BUG-12](#bug-12--derivestatus-collapses-all-non-approval-pauses-to-waiting) | Low | Operator UI | All non-approval pauses render as `waiting for you` | — |
| [BUG-13](#bug-13--resolving-a-workflow-childs-approval-strands-the-root-paused) | High | Execution / HITL | Resolving a workflow child's approval leaves the workflow root stranded `paused` | D5 |
| [BUG-14](#bug-14--workflow-replay-re-runs-a-completed-child-agent) | High | Execution / HITL | Workflow replay re-dispatches a completed child, re-invoking the model (fails on assistant-prefill) | D5 |

> **Note:** BUG-13/14 were surfaced by live end-to-end testing of a workflow-with-approval-gate on the local demo (not spec reconciliation). They are the two halves of "workflow HITL resume is half-wired": the pause seam is correct, the resume path was not.

---

## High

### BUG-01 — Cancel store not auto-wired to Postgres

- **Area:** Execution / control plane · **Spec:** `02-execution.md` (Runtime & composition, Cancellation)
- **Evidence:**
  - `createRuntime()` defaults to `MemoryCancelStore` — `packages/sdk/src/runtime.ts:262`
  - Gateway falls back to a no-op cancel store when none is passed — `packages/gateway/src/app.ts:83`
  - The loop polls `runtime.cancelStore` — `packages/engine/src/run-context.ts:155-163`
  - `PgCancelStore` (which implements the poll-Postgres model) is never wired by default — `packages/store/src/pg/cancel-store.ts:17-29`
- **Symptom / impact:** In a standard Postgres deployment where the caller doesn't manually construct and share a `PgCancelStore`, the gateway's cancel request is written to a different (or no-op) store than the one the loop polls. `POST /runs/:id/cancel` returns `200` but the in-flight loop never stops. Directly contradicts D10's cancellation seam.
- **Proposed fix:** When `DATABASE_URL` is set, default `runtime.cancelStore` to a `PgCancelStore` backed by the store's pool; have the gateway reuse `runtime.cancelStore` rather than a separate instance. Add a parity test that cancels an in-flight run through the gateway route.

### BUG-02 — Hook veto crashes the run

- **Area:** Execution / hooks · **Spec:** `02-execution.md` (Hooks)
- **Evidence:**
  - A hook `reject` throws `EventRejectedError` from `append` — `packages/store/src/memory-store.ts:68`
  - The runner emits `tool.called` without catching that error — `packages/engine/src/default-runner.ts:308`
- **Symptom / impact:** A gate hook returning `{ action: "reject" }` on `tool.called` throws out of the emit path and fails the entire run (`run.failed`), instead of producing a canonical error `tool_result` the model can recover from. Contradicts D9 (error containment) and the documented hook-veto contract.
- **Proposed fix:** Wrap the `tool.called` emit; on `EventRejectedError`, skip invocation and synthesize an error `tool.result` (with the veto reason), then continue the loop. Add a test for a vetoing gate hook.

### BUG-03 — Scaffolder gateway missing execution mode `queue`

- **Area:** Deploy / scaffolder · **Spec:** `04-operations.md` (Deployment model, Configuration)
- **Evidence:**
  - Default `executionMode` is `inline` unless `RENDER_AGENTS_EXECUTION_MODE=queue` — `packages/sdk/src/runtime.ts:269-270`; enqueue only happens in queue mode — `packages/sdk/src/submit.ts:37-47`
  - Scaffolder `render.yaml` gateway env omits the var while still deploying a chat-worker — `packages/create-render-agents/src/blueprint.ts:478-508`
- **Symptom / impact:** Generated deployments run chat turns **inline in the gateway** while the deployed `chat-worker` service sits idle — double spend and a violation of D12 ("gateway never executes a root in production").
- **Proposed fix:** Set `RENDER_AGENTS_EXECUTION_MODE=queue` on the gateway service in the scaffolder `render.yaml`. Consider defaulting `executionMode` to `queue` when `DATABASE_URL` is present (documented behavior change).
- **RESOLVED:** The scaffolder `render.yaml` gateway now sets `RENDER_AGENTS_EXECUTION_MODE=queue`, so chat roots/resumes enqueue to `run_jobs` and the warm chat-worker drives them (verified: the worker drains `agent`/`resume` kinds in-process).

### BUG-04 — Scaffolder gateway missing Render Workflows trigger env

- **Area:** Deploy / scaffolder · **Spec:** `04-operations.md` (Deployment model, Configuration)
- **Evidence:**
  - Dispatcher auto-select requires both `RENDER_API_KEY` + `RENDER_WORKFLOW_SLUG` — `packages/sdk/src/dispatch.ts:462`
  - Scaffolder gateway env includes neither — `packages/create-render-agents/src/blueprint.ts:478-488`
- **Symptom / impact:** Without those vars the gateway uses `InProcessDispatcher` and drives workflow **roots in-process** (`packages/sdk/src/workflow.ts:161-169`), so the separate `workflows` worker is never used — Lane A is effectively disabled in generated deploys.
- **Proposed fix:** Add `RENDER_API_KEY` (secret) + `RENDER_WORKFLOW_SLUG` to the gateway service env in `render.yaml`. Document that the workflows worker gets its in-container `RENDER_SDK_SOCKET_PATH` from Render at runtime.
- **RESOLVED:** The gateway env now includes `RENDER_WORKFLOW_SLUG` (points at the `<name>-workflows` service) and `RENDER_API_KEY` (`sync: false`). Leaving the key empty is a *safe* default — the dispatcher auto-selects Render Workflows only when both are present, so the gateway drives roots in-process until an operator pastes a Render API token, then upgrades automatically. `@renderinc/sdk` is now a generated dependency so the dispatcher can resolve it at runtime.

### BUG-13 — Resolving a workflow child's approval strands the root paused

- **Area:** Execution / HITL · **Spec:** `02-execution.md` (HITL), `04-operations.md` (D5, two-lane resume)
- **Evidence:**
  - When a gated tool is called inside a workflow, the gate fires in the **child** agent run (`.task()`/`.run()`), so `approval.requested` + the approval record carry the *child* run id — `packages/engine/src/run-context.ts` (`requestApproval`), `packages/sdk/src/workflow.ts` (`createRunScopedAgent`).
  - The `RunPaused` propagates and the **workflow root** records its own `run.paused` — `packages/sdk/src/workflow.ts` (`executeHandler`).
  - The gateway resume routing keyed only off the *resolved* run's `workflow`: a child agent run isn't a registered workflow, so it took the Lane B `resumeRun` branch and never re-triggered the parent root — `packages/gateway/src/app.ts` (`resume`).
- **Symptom / impact:** Resolving the approval (`POST /approvals/:id/resolve`) resumed only the child; the workflow root stayed `paused` forever. A workflow-with-approval-gate could never complete via the operator flow — Lane A HITL was effectively broken end-to-end (contradicts D5's re-trigger-on-resume contract).
- **RESOLVED:** The gateway resume now walks `runs.parent_span_id` (migration `0008`) from the resolved child up to the nearest **paused workflow root** and re-drives *that* root (`dispatchRoot` → in-process drive in dev). Its replay re-dispatches the still-paused child, which sees the now-resolved approval in its own log and proceeds past the gate. A single `resolve` drives both child and root to `completed`. Regression: `packages/gateway/tests/hitl.test.ts` ("a single /approvals/:id/resolve drives both the gated child and the paused workflow root to completion").

### BUG-14 — Workflow replay re-runs a completed child agent

- **Area:** Execution / HITL · **Spec:** `02-execution.md` (durability / replay)
- **Evidence:**
  - `ctx.step` results are memoized on replay, but `agent.task()`/`agent.run()` children were not — the proxy re-dispatched by deterministic child id on every drive — `packages/sdk/src/workflow.ts` (`createRunScopedAgent`).
  - The runner has no terminal-state short-circuit: re-driving a completed run replays its transcript, finds no pending tool uses, and calls the model again with a history ending on an assistant turn — `packages/engine/src/default-runner.ts` (`run` / `pendingToolUses`).
- **Symptom / impact:** On any workflow re-drive (crash recovery, duplicate delivery, or the HITL re-trigger from BUG-13's fix), an already-`completed` child was re-invoked — re-running side effects and, against a real provider, failing with `400 … does not support assistant message prefill. The conversation must end with a user message`, which marked the root `failed`. (Observed live: the deploy tool would have fired twice.)
- **RESOLVED:** `createRunScopedAgent` now memoizes: before dispatching, a child whose deterministic run id is already `completed` returns its stored result instead of re-entering the model loop. Only `completed` short-circuits — a still-`paused` child is re-dispatched so a now-resolved approval lets it proceed. Regression: `packages/sdk/tests/workflow-lane.test.ts` ("replay idempotency: re-driving a workflow memoizes a completed child").

> **Scope note:** Both fixes keep the durable `run.paused (approval)` seam intact and are deliberately interim — when native Render Workflows pause/resume ships, the resume *mechanism* (re-trigger + replay) is swapped behind the same seam without changing the operator contract.

## Medium

### BUG-05 — Workflows host entrypoint is a stub — RESOLVED

- **Area:** Deploy / scaffolder · **Spec:** `04-operations.md` (Deployment model, D5)
- **Evidence (before):** the generated `src/workflows.ts` logged readiness with task registration commented out. (Note: `examples/demo/src/workflows.ts` had already been fully implemented; only the scaffolder blueprint lagged.)
- **Resolution:** `@renderinc/sdk@0.6.0` exposes the task-host API (`task()` from `@renderinc/sdk/workflows`; the SDK auto-starts the task server when `RENDER_SDK_SOCKET_PATH` is set), so the host is no longer blocked. The blueprint's `workflowsHostEntry()` now matches the reviewed demo: it registers a `workflow@<plan>` + `agent@<plan>` pair per referenced plan tier (`computeRequiredPlans`), binding them to `workflowTaskHandler` / `agentTaskHandler` (resolve-by-name, JSON-only). When no Render runtime is present it idles (keep-alive) so the in-process Docker demo still boots. `@renderinc/sdk` is now a generated dependency.

### BUG-07 — Thread & global SSE streams unreliable on reconnect — RESOLVED

- **Area:** Platform / SSE · **Spec:** `03-platform.md` (SSE streaming), `06-operator-ui.md` (Cross-cutting SSE)
- **Evidence (before):** thread stream was live-tail only (no catch-up); per-run `seq` was used as the SSE id, colliding across a thread's runs; the global tail never replayed.
- **Resolution:**
  - Added `EventLogStore.readThread(threadId)` (memory + Postgres), returning a thread's durable events across all its runs in a single canonical order (`ts, runId, seq`).
  - The thread stream now does a **catch-up replay** on connect from the `Last-Event-ID` cursor, then tails live (de-duping the small catch-up/tail overlap), matching the run stream's semantics.
  - Thread + global streams now emit a **composite `runId:seq`** SSE id, so `Last-Event-ID` is a collision-free reconnect cursor. The single-run stream keeps its numeric `seq`.
  - The global tail stays **live-tail only** by explicit design (a full-log replay would be unbounded); the composite id + the operator UI's REST refetch-on-connect cover reconnect. Documented in `03-platform.md`.

### BUG-09 — `requireApproval` on subagents fails load validation

- **Area:** Authoring / HITL · **Spec:** `01-authoring.md` (Tool references)
- **Evidence:** Subagent tools (`subagents__<name>`) are mounted at run time — `packages/engine/src/default-runner.ts:59-60` — and are **not** included in the load-time expanded tool set — `packages/sdk/src/loader/load-agents.ts:118-128` — so `resolveToolReferences` rejects them — `packages/sdk/src/loader/tool-resolver.ts:60`.
- **Symptom / impact:** `requireApproval: [subagents__researcher]` fails validation even when `subagents: [researcher]` is declared, so delegation can't be gated via approval despite the docs describing it. Contradicts D6.
- **Proposed fix:** Include declared subagent tool ids (`subagents__<name>`) in the load-time approval-validation set.

### BUG-10 — MCP tool namespace ignores directory name

- **Area:** Authoring / tools · **Spec:** `01-authoring.md` (Tools)
- **Evidence:** `defineMcpSource` derives the model-facing namespace from `spec.name ?? "mcp"`, not the directory key — `packages/engine/src/tool-impl.ts:72-87`.
- **Symptom / impact:** If an author omits `name`, the model sees `mcp__*` instead of `<dir>__*`. Agent frontmatter references the directory name, so `requireApproval` and the `tools[]` allowlist (keyed on the directory) can mismatch the actual tool names. Contradicts D6's directory-key convention.
- **Proposed fix:** Default the MCP source id/namespace to the directory key when `name` is omitted (and/or hard-error if a provided `name` disagrees with the directory).

## Low

### BUG-06 — Scaffolder `render.yaml` hardcodes npm

- **Area:** Deploy / scaffolder · **Spec:** `04-operations.md` (Deployment model, D9)
- **Evidence:** `render.yaml` build/start commands hardcode `npm install && npm run build` — `packages/create-render-agents/src/blueprint.ts:475-476` — while the wizard supports pnpm/npm/yarn — `packages/create-render-agents/src/index.ts:73-82`.
- **Symptom / impact:** Projects scaffolded with pnpm/yarn get a `render.yaml` that uses npm commands; operators must hand-edit.
- **Proposed fix:** Template the build/start commands from the chosen package manager.
- **RESOLVED:** `render.yaml` build/start commands are now templated via `pmInstall`/`pmRun` from `opts.packageManager` across every service (gateway/chat-worker/workflows) and cron, so a pnpm/yarn project gets `pnpm …`/`yarn …` commands.

### BUG-08 — `Thread.currentRunId` never populated — RESOLVED

- **Area:** Platform / threads · **Spec:** `03-platform.md` (Threads)
- **Evidence:** Field was on the type — `packages/store/src/thread-store.ts` — but `mapThreadRow` never set it.
- **Resolution:** Removed the field from the `Thread` domain object (store + UI types) rather than populating it — "which run is active" is a projection of the `runs` table, not thread state, so embedding it in the data model invited drift and coupled a domain object to a UI concern. `GET /runs` now accepts a `threadId` filter, and the operator UI's `ChatView` derives the thread's active run via `client.listRuns({ threadId })` (roots-only), picking the one non-terminal run (`idx_runs_thread_active` guarantees at most one). Specs `03-platform.md` / `05-type-reference.md` updated.

### BUG-11 — Chat composer enabled during needs-approval

- **Area:** Operator UI · **Spec:** `06-operator-ui.md` (Chat)
- **Evidence:** Composer is disabled only when `status === "thinking"` — `packages/gateway/ui/src/views/ChatView.tsx:254` — while the server 409s a message sent during an approval pause — `packages/gateway/src/routes/threads.ts:122-126`.
- **Symptom / impact:** A user can type and send during `needs approval`; the message is rejected with a 409 banner instead of the UI preventing it.
- **Proposed fix:** Disable the composer when `status === "needs-approval"`.
- **RESOLVED:** The composer is now blocked while `thinking` or `needs-approval` (`inputBlocked` gates the textarea + Send). An **input** pause (`waiting`) deliberately keeps it open — the server accepts a message there to resume the run — with a "waiting for your reply…" placeholder.

### BUG-12 — `deriveStatus` collapses all non-approval pauses to `waiting`

- **Area:** Operator UI · **Spec:** `06-operator-ui.md` (Chat)
- **Evidence:** `deriveStatus` maps any pause without a pending approval to `waiting for you` — `packages/gateway/ui/src/views/ChatView.tsx:319-324`.
- **Symptom / impact:** A pause whose reason isn't captured by the approval list can flash the wrong status during a race. Minor; correct when the approval list is authoritative.
- **Proposed fix:** Distinguish pause reason from the last `run.paused` event rather than inferring solely from the approval list.
- **RESOLVED:** `GET /runs/:id` now surfaces `pauseReason` (`approval` | `input`) from the last `run.paused` event, and `deriveStatus` uses it — an approval pause is `needs-approval` even before the approval row loads; only an input pause is `waiting`.

---

## Already tracked elsewhere

- **Hash routing has no path canonicalization** (`/ui/approvals` → `/ui/approvals#/approvals`, never self-corrects) — captured in [`sprints/03-ui-redesign.md`](sprints/03-ui-redesign.md).
- **Two-lane execution** (warm chat worker + `run_jobs` drain, `dispatchRoot`/`startTask` seam) — the broader rollout is the scope of [`sprints/01-queue.md`](sprints/01-queue.md), not a bug. The scaffolder/config consequences that were in scope here (BUG-03/04/05/06) are now resolved: generated deploys wire queue mode, the Render Workflows trigger env, and a real workflows host.
