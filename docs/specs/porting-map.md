# Code Provenance — Lift-and-Shift Map

**Status:** NON-NORMATIVE (implementation guidance)
**Companion to:** the layered spec (entry: [`00-foundations.md`](00-foundations.md))

> This document is **not** part of the canonical technical contract. It maps each
> area of the spec to the existing implementation that should be ported, adapted,
> or used as reference. Contracts and data models live in the layered spec
> ([`00-foundations.md`](00-foundations.md) → [`05-type-reference.md`](05-type-reference.md));
> sprint specs reference both. The two source repos are:
>
> - **H** = `render-agent-harness`
> - **T** = `agent-workflows-template`

## 1. From `agent-workflows-template` (orchestration kernel)

The template is the closer starting point for the SDK's core architecture. Its engine is small, clean, and already structured around the authoring and execution model we're building.

| Spec area | Template source | Adaptation |
|---|---|---|
| **Markdown agent loading + validation** | `src/engine/parse-agents.ts` | Extend frontmatter schema (add `plan`, `runner`, `permissions.requireApproval`). Add `_shared.md` merge. Wire Zod validation for fail-fast. |
| **Agent types** (`AgentDefinition`, `AgentSet`, `AgentTask`) | `src/engine/types/agent.ts` | Rename `AgentTask` → `Agent`. Add `.task()` alongside `.run()`. Add `plan` (`RenderPlan`), `runner`, `context` fields. Bind agents to `AgentRuntime` ([Execution → Runtime & composition](02-execution.md#runtime--composition)). |
| **Runtime / composition root** (`createRuntime`, `AgentRuntime`, `TaskDispatcher`) | *(new — no direct source)* | New code. Auto-detect store/model/dispatcher from env. Shared by gateway + workflow service. |
| **Task dispatch** (`agent.task()` → Render Workflows) | *(new — wraps `@renderinc/sdk/workflows`)* | Auto-register plan-tier `agent@<plan>` tasks; chained-run dispatch inside handlers, `client.runTask` from gateway, in-process fallback locally. Deterministic dispatch keys. |
| **Workflow handler + `ctx.step`** | `src/workflows/code-review/index.ts` | Add `ctx.step()` memoization (`step.completed` events → `workflow_steps` projection), `retries=0` default, determinism contract ([Execution → Determinism & replay](02-execution.md#determinism--replay)). |
| **Tool system** (`defineTool`, `defineMcpSource`, `ToolSource`) | `src/engine/tool.ts`, `types/tool.ts` | Direct lift. Add `ConnectorSpec` support. |
| **Skill system** (`SkillMetadata`, `loadSkills`, `load_skill` tool) | `src/engine/skills.ts`, `types/skill.ts` | Direct lift. |
| **Event log + projections** (`run_events`, `EventLogStore`) | *(new — D10)* | New canonical log; append folds into maintained projections; the single write path. |
| **Context management / compaction** (`ContextManager`) | *(new — D11)* | New code in `@render-agents/engine`: default auto-compaction (summarize old/preserve decisions/drop redundant/JIT), emits `context.compacted`. |
| **Hooks** (event-stream middleware) | *(new — D10)* | New code: discover `hooks/`; run each appended event through hooks (observe/transform/veto) before commit. |
| **LLM loop** (`runLoop`) | `src/engine/loop.ts` | Extend with: cancellation check, context compaction (D11), event emission (`ctx.emit` — replaces ad-hoc message/tool persistence), idempotency via log lookup, HITL pause (placeholder tool_result), cost via `llm.call` events. Core iterate/call/dispatch structure stays. |
| **Model client + tiers** | `src/engine/model.ts`, `model-tiers.ts` | Direct lift. Add `estimateCost`. |
| **Environment** (tool registry, mount/dispose) | `src/engine/environment.ts`, `types/environment.ts` | Direct lift. |
| **Tracing** (`Tracer`, `SpanInfo`) | `src/engine/store/tracer.ts`, `types/trace.ts` | Spans become a **projection** of span-producing events; the tracer emits those events rather than writing a separate spans store. Keep the `workflow`/`step` span kinds ([Type Reference](05-type-reference.md#spankind)). |
| **Store** (RunStore, memory + Postgres) | `src/engine/store/` | **Re-center on the event log.** New canonical `run_events` table + `EventLogStore` (append/read/tail). `runs`, `spans`, `run_messages`, `tool_calls`, `workflow_steps`, `approval_requests` become maintained projections folded on append. The harness's separate message-persistence, idempotency store, and NOTIFY emission all collapse into `events.append`. |
| **Workflow composition** | `src/workflows/code-review/index.ts` | Reference for `workflow()` helper design. The code-review pipeline becomes the scaffolder's default example. |
| **Gateway + webhooks** | `src/main.ts`, `src/server/` | Adapt to Hono. Add threads, HITL, OAuth, schedule routes (from harness). |
| **Trace UI** | `src/ui/` | Direct lift as dev-mode trace viewer. |

## 2. From `render-agent-harness` (platform substrate)

The harness provides production-grade infrastructure that the template lacks. These modules are ported into `@render-agents/gateway` and `@render-agents/store`, adapted to the new data models.

| Spec area | Harness source | Adaptation |
|---|---|---|
| **HITL approval flow** | `core/src/loop-steps.ts` (`pauseForApproval`, `replayPendingToolUses`, `pauseForAwaitingInput`) | Port pause/resume logic. Adapt to our `RunContext.requestApproval()` contract. The placeholder `tool_result` trick and replay-pending-uses are critical. |
| **Idempotent tool dispatch** | `core/src/idempotency.ts` | Keep the key (`SHA-256(runId + toolCallId)`), but the check/record is now a log lookup/emit: `appliedToolResult` reads the `tool.result` event; no separate idempotency store. |
| **OAuth implementation** | `core/src/connections.ts` | Port: AES-256-GCM encryption, `SELECT FOR UPDATE` refresh, `SecretsContext` builder. Adapt to our `OAuthStore` + `ToolContext.connection()` contract. |
| **OAuth HTTP routes** | `web/src/routes/connections.ts` | Port: `/start`, `/callback`, `DELETE`. Adapt HMAC state signing. |
| **SSRF-guarded fetch** | `core/src/builtins/fetchUrl.ts` | Direct lift into `@render-agents/engine`. DNS resolve + private IP block via `ipaddr.js`, redirect re-check, size/timeout caps. |
| **Cooperative cancellation** | `core/src/cancel.ts` | Port pattern: Valkey `cancel:{runId}` with poll. Adapt to our `CancelStore` interface. |
| **Thread model** (harness "conversation") | `web/src/routes/conversations.ts`, `core/src/state/repo.ts` | Port: `loadConversationMessages` (cross-run history), sequential-only enforcement (unique index), `409 thread_busy` on concurrent turns. Rename the harness's "conversation" to **thread**; the harness's cross-run history is exactly our thread-spans-runs model. |
| **SSE streaming** | `web/src/routes/runs.ts` (SSE handler), `core/src/state/repo.ts` (NOTIFY) | Port the pointer-payload NOTIFY pattern + dedicated `pg.Client` for LISTEN, but point it at `run_events`: the SSE stream is a live tail of the log (`EventLogStore.tail`), resumable from a `seq` offset — no separate SSE event vocabulary. |
| **Budget enforcement** | `core/src/loop.ts` (`overBudget`, `estimateCost`, `addUsage`) | Port cost estimation. Adapt `DEFAULT_BUDGET` (harness defaults: `maxCostUsd: 10`, `maxWallSeconds: 39600`). |
| **Run state repo** | `core/src/state/repo.ts` | Reference for the append pattern: `next_seq()` becomes the event log's `seq`; status transitions and message history become projections folded on `events.append`; NOTIFY fires per appended event. |
| **Migrations + advisory lock** | `core/sql/*.sql`, `core/src/state/schema.ts` | Port advisory-lock pattern for safe concurrent migration. Adapt table schemas to our spec. |
| **API key auth** | `web/src/auth.ts` | Port: constant-time compare, fail-closed on missing key. |
| **Input validation** | `web/src/routes/*.ts` | Port: non-empty input strings, pause-reason body matching, agent name resolution. |
| **Scaffolder** | `create-render-agent/` | Port wizard flow (`@clack/prompts`), `buildFileMap`, blueprint emission. Adapt to generate our project layout. |

## 3. Not ported (intentionally dropped)

| Harness module | Why |
|---|---|
| **Four runtime adapters** (`runtime-web`, `runtime-worker`, `runtime-cron`, `runtime-workflows`) | Replaced by one model: `agent.run()` (in-process) + `agent.task()` (Workflow). Cron and webhooks are trigger types, not runtimes. |
| **Capability packs** (`definePack`, namespace mangling) | Replaced by convention-discovered tools with flat names and hard-error collisions. The `ConnectorSpec` covers the inbound-webhook contribution packs provided. |
| **`render-harness.yaml`** config schema | No project-level config file. Replaced by `package.json` (project metadata), markdown frontmatter (agent config), `render.yaml` (deploy), and env vars (infra). Agent identity lives in the agent file, not a config registry. |
| **YAML agent definitions** | Replaced by markdown-first authoring. |
| **Gallery / registry index** | Deferred. The scaffolder generates projects directly; a registry of templates is a future concern. |
| **Operator UI** (`@render-harness/ui`) | Deferred to post-MVP. The trace UI from the template serves as the initial dev-mode viewer. |
| **pg-boss queue** | Replaced by Render Workflows for job dispatch. The gateway dispatches workflows directly; no intermediate queue. |
| **Valkey for cancel** | Replaced by `CancelStore` interface — implementations can use Render KV, Postgres flag, or in-memory. |

## 4. Porting principles

1. **Port contracts, not code.** The harness is callback-heavy and config-driven. Extract the logic, implement it against our interfaces.
2. **Flatten the dependency graph.** The harness has 10+ packages with complex cross-deps. Our monorepo has 4 packages with a clean tree.
3. **Delete the YAML layer.** Every place the harness reads from `render-harness.yaml` or `AgentDefinition` built by `defineFromConfig`, we read from markdown frontmatter (agent config) or `package.json` (project metadata). There is no project-level config file.
4. **Keep the SQL.** The harness's migration patterns (advisory lock, idempotent `CREATE TABLE IF NOT EXISTS`, index naming) are production-proven.
5. **Test against the harness's edge cases.** The harness handles: concurrent thread turns, mid-loop crashes, OAuth token races, SSRF via DNS rebinding, budget overflow on the last turn. These are the test cases we must not lose.

---

*Cross-references point into the layered spec ([`00-foundations.md`](00-foundations.md) and its sibling layer files).*
