# Execution

**Layer:** L2 — *what happens at runtime.* Part of the [render-agents specification](00-foundations.md) ([Document Map](00-foundations.md#document-map)).

This layer covers everything that happens when an agent runs: how the runtime is composed, the agent loop, dispatch, determinism and replay, HITL pause/resume, tool execution, persistence, structured output, and the safety rails around it all. What you author lives in [Authoring](01-authoring.md); exact type shapes live in the [Type Reference](05-type-reference.md); what persists and serves lives in [Platform](03-platform.md).

Each section follows the same shape: **Purpose** (what & why), **Model** (how it works), **Contract** (link to exact types), and an **Example** where useful.

---

## Runtime & composition

**Purpose** — Agents returned by `loadAgents()` are inert definitions until bound to a **runtime** — the composition root that supplies the model client, store, tracer, runner registry, and (in production) the task dispatcher. Both the gateway and the workflow service construct the *same* `AgentRuntime` via `createRuntime()`, so wiring is identical across services.

**Model** — `createRuntime()` builds the runtime, auto-detecting each dependency from the environment:

| Dependency | Default resolution |
|---|---|
| Store | Postgres if `DATABASE_URL` set, else in-memory |
| Model client | Provider inferred from the agent's `model` (or its `apiKeyEnv`) |
| Runner registry | `default` → `DefaultRunner`, plus adapters in `runners/` |
| Dispatcher | Render Workflows dispatcher when `RENDER_SDK_SOCKET_PATH` / `RENDER_USE_LOCAL_DEV` present; otherwise in-process fallback (`.task()` runs as `.run()`) |

**Binding.** `loadAgents(dir?, runtime?)` accepts an optional runtime. When omitted, the loader lazily builds one with `createRuntime()` (env-driven defaults). Every `Agent` produced by the set closes over this runtime, so `agent.run()` / `agent.task()` already know which model, store, tracer, runner, and dispatcher to use — there is no global singleton and no per-call dependency wiring. `loadAgents()` itself:

1. `dir` defaults to `"./agents"` relative to the project root.
2. `runtime` defaults to `await createRuntime()` (env-driven auto-detection).
3. Scans `dir` for `*.md` files (non-recursive). Skips `_shared.md`.
4. Parses each file: extracts YAML frontmatter and body.
5. If `_shared.md` exists, loads it and merges into each definition.
6. Loads `tools/` and `skills/` registries from sibling directories.
7. Validates every frontmatter field. Fails fast on the first error.
8. Resolves model spec (tier or raw string) and `plan` (must be a known `RenderPlan`).
9. Binds every `Agent` to the `runtime` (model, store, tracer, runner registry, dispatcher).
10. Returns an `AgentSet` with `.get()`, `.has()`, `.all()`.

**`loadAgents` is bootstrapping, not in-handler API.** The gateway and workflow service call `loadAgents()` once at startup to build the project AgentSet; the workflow runtime then exposes a run-scoped view of that same set as `ctx.agents` for each run. **Inside a workflow handler, always use `ctx.agents`** — it carries the current run's id, tracer, and parent span so spans nest and dispatch/idempotency keys are correct. Use a module-level `loadAgents()` closure only *outside* a handler (scripts, tests, gateway dispatch); a closure used inside a handler is not run-scoped and will mis-correlate traces. There is exactly one in-handler path (`ctx.agents`).

**Contract** — [`AgentRuntime`](05-type-reference.md#agentruntime), [`CreateRuntimeOptions`](05-type-reference.md#createruntimeoptions), [`RunnerRegistry`](05-type-reference.md#runnerregistry), [`TaskDispatcher`](05-type-reference.md#taskdispatcher), [`DispatchOptions`](05-type-reference.md#dispatchoptions), [`DelegationLimits`](05-type-reference.md#delegationlimits).

---

## Events

**Purpose** — Every run is an append-only log of typed events, and that log is the single source of truth. One taxonomy serves persistence, the trace tree, the SSE stream, hooks, and cost — emitted once.

**Model** — Runtime code never writes a store directly; it calls `ctx.emit(event)`. Each append atomically: persists to `run_events`, updates the affected **projections** (messages, spans, tool-calls, steps, cost, run status), `NOTIFY`s the SSE tail, and passes the event through [hooks](#hooks). Events are immutable and versioned. Categories (AG-UI-aligned — subscribe by category, not by individual name):

| Category | Events | Drives projection |
|---|---|---|
| lifecycle | `run.started/completed/failed/paused/cancelled` | run status |
| message | `message.assistant`, `message.tool`, `text.delta` | message history |
| tool | `tool.called`, `tool.result` | tool-calls (idempotency) |
| step | `step.started`, `step.completed` | step memoization |
| model | `llm.call` | cost / usage |
| approval | `approval.requested/resolved/auto` | approvals |
| delegation | `subagent.spawned` | trace tree |
| context | `context.compacted` | (audit) |

Everything downstream is a fold of this log: message history, the span tree (observability), tool-call idempotency, step memoization, cost, run status, and the SSE stream are all projections (see [Platform → Store](03-platform.md#store--postgres-schema)). This is why resume, idempotency, and memoization are one mechanism — "is it already in the log?" — rather than separate subsystems.

**Contract** — [`RunEvent`](05-type-reference.md#runevent), [`EventCategory`](05-type-reference.md#eventcategory), [`RunEventRecord`](05-type-reference.md#runeventrecord), [`EventLogStore`](05-type-reference.md#eventlogstore).

---

## The agent loop

**Purpose** — The default runner drives the iterate → call model → dispatch tools cycle. The same loop runs everywhere: in-process and as a dispatched task behave identically.

**Model** — Before the first iteration, the runner assembles the system prompt (agent body + `_shared.md` + skill catalog, see [Skill loading](#skill-loading)) and mounts the agent's tools — including the built-in `load_skill` tool when the agent declares any skills. Then it executes this cycle. Every persisting step is an `emit` to the event log (see [Events](#events)); the trace tree, messages, idempotency, and cost are projections of those emits. `load_skill` is dispatched like any other `tool_use` in step 8:

```
[user input]
    │
    ▼
┌─ ITERATE ──────────────────────────────────────┐
│  1. Check cancellation (ctx.isCancelled)        │
│  2. Check budget (iterations, tokens, cost)     │
│  3. Check abort signal                          │
│  4. Compact context if over threshold           │
│  5. Call model  → emit llm.call                 │
│  6. Emit message.assistant                      │
│  7. If stop_reason = end_turn → return          │
│  8. For each tool_use in response:              │
│     a. appliedToolResult → short-circuit if hit │
│     b. Check requireApproval → HITL gate        │
│     c. Validate input vs inputSchema            │
│     d. Emit tool.called; dispatch tool          │
│     e. Emit tool.result                         │
│  9. Emit message.tool                           │
│ 10. Go to 1                                     │
└─────────────────────────────────────────────────┘
```

**Local = production parity.** The loop, tool dispatch, permissions, budget enforcement, event emission, and all observable behavior are identical whether an agent runs via `agent.run()` (in-process) or `agent.task()` (Workflow task). Both emit the same events (and therefore produce the same projections — messages, spans, cost) to whatever store is available. The only differences are in the execution container:

- `agent.run()`: shares the caller's process, no retries, no container isolation.
- `agent.task()`: own container on the agent's `plan`, Render Workflows retries.

When Postgres is available (production, or local dev with `DATABASE_URL` set), both modes persist to it. When Postgres is not available (local dev without a database), both modes fall back to the in-memory store. The persistence behavior follows the store, not the execution mode. Pipeline code does not need to know or care which mode is in use: the same agent markdown, the same tool set, the same runner, the same store, the same output shape.

**Contract** — [`AgentRunner`](05-type-reference.md#agentrunner), [`RunContext`](05-type-reference.md#runcontext), [`Message`](05-type-reference.md#message).

---

## Budgets & cost

**Purpose** — Every agent invocation is bounded so a runaway loop cannot burn unlimited iterations, tokens, time, or money.

**Model** — Budgets are **per agent invocation** (the `budget` block is an agent-level field) and are checked at the top of each iteration, before the LLM call:

| Budget field | Default | Behavior when exceeded |
|---|---|---|
| `maxIterations` | 50 | Error: "maxIterations reached" |
| `maxTokens` | 1,000,000 | Error: "token budget exhausted" |
| `maxCostUsd` | 10 | Error: "cost budget exhausted" |
| `maxWallSeconds` | (none) | AbortSignal fires via `setTimeout` |

Cost is computed via `estimateCost(model, usage)` after each `complete()` call: it is accumulated against the agent invocation's running total for budget enforcement, and also added to the run-wide `RunRecord.totalCostUsd` for reporting/attribution.

**Cost estimation.** `estimateCost(model, usage)` looks up per-1M-token pricing in `MODEL_PRICING`:

- **Routable but unpriced models** default to `0` cost (cost budget not enforced — not a hard error), but with a **loud warning emitted at load time** (visible in CI), repeated at runtime. The other budgets (`maxIterations`, `maxTokens`, `maxWallSeconds`) still apply regardless, so an unpriced model is never fully unbounded.
- **Custom/unlisted model pricing** is supplied by extending the table via `createRuntime({ pricing })` (merged over the built-in `MODEL_PRICING`). Once registered, the model is priced and the cost budget is enforced normally.
- **Explicit opt-out:** set `budget.maxCostUsd: null` (or `0`) to deliberately disable the cost ceiling. This silences the unknown-pricing warning for that agent — the choice is then explicit rather than accidental.

Transient model failures are retried transparently by the default `ModelClient` per its `RetryPolicy`: retries are **not** new loop iterations and add no token budget, though `maxWallSeconds` still bounds total elapsed time.

**Contract** — [`Budget`](05-type-reference.md#budget), [`ModelPricing`](05-type-reference.md#modelpricing) / [`MODEL_PRICING`](05-type-reference.md#model_pricing) / [`estimateCost`](05-type-reference.md#estimatecost), [`RetryPolicy`](05-type-reference.md#retrypolicy).

---

## Context management

**Purpose** — Context is managed, never unbounded. Budgets bound *cost*; compaction protects *quality*. "Context rot" degrades model performance well before a token budget trips — and for coding agents a single file read or test log can dwarf the rest of the window — so the model-visible window is a managed projection, not an ever-growing append.

**Model** — Before each model call (loop step 4), the runner asks the `ContextManager` to `prepare` the model-visible window from the full message history:

1. **Threshold.** If estimated tokens stay under the agent's `maxContextTokens` (default ~75% of the model's window), history passes through unchanged.
2. **Compaction (default "auto" strategy).** Over the threshold, the strategy: keeps recent turns verbatim; summarizes older turns while **preserving decisions and unresolved items**; drops redundant/superseded tool output (e.g. an old file read later re-read); and prefers JIT re-retrieval over keeping large blobs resident.
3. **Observable + recoverable.** Compaction emits a `context.compacted` event (`beforeTokens`/`afterTokens`/`strategy`). The **full history stays in the event log** — compaction only changes what the *model* sees next, never what's recorded. A run can always be reconstructed in full from the log.
4. **Configurable.** Agents set `context: { compaction, maxContextTokens }` in frontmatter (see [Authoring → Agent markdown schema](01-authoring.md#agent-markdown-schema)); `compaction: none` disables it; custom strategies are provided via `createRuntime({ contextManager })`.

**Contract** — [`ContextManager`](05-type-reference.md#contextmanager), [`ContextConfig`](05-type-reference.md#contextconfig), [`CompactionStrategy`](05-type-reference.md#compactionstrategy).

---

## Run vs task dispatch

**Purpose** — A single execution model: `run` vs `task` is a method call, not config. The same definition runs in-process or as an isolated Render Workflow task with the same output shape.

**Model** — The two methods differ only in the execution container:

| | `agent.run(input)` | `agent.task(input)` |
|---|---|---|
| Execution | In-process | Render Workflow task (isolated container) |
| Use case | Lightweight steps, judges, local dev | Production parallelism, heavy compute |
| Container | Shares the caller's process | Own container on the agent's `plan` |
| Retries | None (caller manages) | Render Workflows retry policy |
| Persistence | Same store as caller | Same store (Postgres in production) |
| Tracing | Same trace context | Spans correlate via `runId` + `parentSpanId` |

Both return `Promise<AgentOutput>` with the same shape, and pipeline code composes them freely (inside a handler, via `ctx.agents`).

**Render Workflows mapping.** `agent.task()` is auto-wired onto Render Workflows (`@renderinc/sdk/workflows`); authors never write a `task()` definition. Render binds the instance type (`plan`) to a task at its `task()` definition, and the run-trigger API takes only a task identifier + input (no per-run plan override). To get per-agent compute anyway, at workflow-service startup the SDK registers a **bounded set of generic dispatch tasks, one per plan referenced across the loaded agents** (plus the default `standard` plan). `pro_plus` / `pro_max` / `pro_ultra` are only registrable when the workspace has been granted access:

```ts
// Registered by the SDK, not the user — one per referenced plan:
//   agent@standard, agent@pro, ...
task({ name: `agent@${plan}`, plan, retry, timeoutSeconds }, agentTaskHandler);
```

Each `agentTaskHandler(agentName, input, dispatchMeta)` reloads the agent from the deployed image by name (only `input` is serialized; definitions are re-loaded, never shipped) and runs it through the default runner. `agent.task(input)` resolves the effective plan from frontmatter `plan` (or the default) and dispatches `(agentName, input)` to the matching `agent@<plan>` task:

- **Inside a workflow handler** → calls the registered task function directly, which Render executes as a durable **chained run** on its own instance and returns a promise for the result.
- **From the gateway / outside a workflow** → uses the Render client `workflows.runTask(id, input)` (or `startTask` + `result.get()`).
- **No workflow server detected** (`RENDER_SDK_SOCKET_PATH` / `RENDER_USE_LOCAL_DEV` unset) → transparently falls back to in-process `.run()`.

**Render Workflows is a hard production requirement.** The in-process fallback is a **local-dev convenience only** (and the basis for the testing runtime) — not a production degraded mode. Task input and output must be JSON-serializable; non-serializable input throws at dispatch time. Each dispatch carries a deterministic key `SHA-256(runId + agentName + callSeq)`; on handler re-execution, re-dispatch returns the existing child run's result instead of starting a new one. The `callSeq` is the per-handler dispatch ordinal, so control flow must be deterministic (see [Determinism & replay](#determinism--replay)).

**Contract** — [`Agent`](05-type-reference.md#agent), [`TaskOptions`](05-type-reference.md#taskoptions), [`TaskDispatcher`](05-type-reference.md#taskdispatcher).

**Example:**

```ts
const findings = await Promise.all(
  ctx.agents.get(["security", "performance", "ux"])
    .map(a => a.task({ patches }))
);
const decision = await ctx.agents.get("judge").run({ findings });
```

---

## Determinism & replay

**Purpose** — Render Workflows is per-task durable, not Temporal-style deterministic-replay. A task runs once, returns a value, and is deprovisioned; on failure the *whole task re-runs* from the top with no memoization. The `workflow()` handler is itself the root task, so determinism is the author's contract.

**Model** — The consequences:

1. **Root handler `retries` default to 0.** A failed handler is not silently re-executed (which would duplicate side effects). The run is marked `failed`; durability and resumption come from child `agent.task()` runs plus the event log (replayed via `ctx.step` memoization and dispatch keys), not blind handler re-runs.
2. **Deterministic, side-effecting, or non-deterministic work goes in `ctx.step(name, fn)`.** Step results are memoized to Postgres by `(runId, name)`. On any handler re-execution (HITL resume, explicit retry), completed steps short-circuit to their stored result. Plain function calls in the handler body are *not* memoized and will re-run.
3. **`agent.task()` dispatches are memoized** via the deterministic dispatch key — completed child runs are not re-dispatched on re-execution.
4. **HITL pause is a deliberate re-execution.** When a child agent pauses for approval, the runner throws `RunPaused`, which bubbles out of the handler; the runtime marks the run `paused`. On approval, the run resumes by re-executing the handler: prior `ctx.step` results and completed `agent.task()` dispatches replay from storage, and the previously-paused agent now returns its completed result.

**Author guidance (documented contract):**

- Handler control flow must be deterministic (the dispatch/step ordinals depend on it).
- All side effects must be wrapped in `ctx.step()` or performed inside an `agent.task()`.
- Do not read wall-clock time, randomness, or external mutable state directly in the handler body — wrap such reads in `ctx.step()` so they are captured once.

```ts
export default workflow(async (ctx) => {
  const patches = await ctx.step("prepare-diff", () => prepareDiff(ctx));

  const findings = await Promise.all(
    ctx.agents.get(["security", "performance"]).map(a => a.task({ patches }))
  );

  const decision = await ctx.agents.get("judge").run({ findings });

  return ctx.step("post-review", () => postReview(ctx, decision));
});
```

**Resume semantics (you always get the result before downstream code).** A paused `agent.task()` does *not* resolve with a partial or empty value. The `await` either resolves with the real result or throws `RunPaused`, which unwinds the handler — nothing after the paused `await` runs on that execution. The *Render task instance* is deprovisioned during the pause (so we don't pin compute waiting on a human), but from the handler's perspective the call simply hasn't returned yet. On approval the run resumes by re-executing the handler with completed work replayed from storage, so execution fast-forwards to the exact paused point — now with its answer — and continues. There is no code-visible state where control flow proceeds without a needed response.

```ts
const [sec, perf] = await Promise.all([
  ctx.agents.get("security").task({ patches }),    // completes
  ctx.agents.get("performance").task({ patches }), // pauses for approval → throws RunPaused
]);
// Nothing below runs until BOTH resolve.
// On resume: security replays from store (not re-run); performance returns its approved result.
const decision = await ctx.agents.get("judge").run({ sec, perf });
```

**Contract** — [`WorkflowContext`](05-type-reference.md#workflowcontext), [`WorkflowOptions`](05-type-reference.md#workflowoptions).

---

## HITL pause & resume

**Purpose** — HITL pause is a control-flow signal resolved by replay. A gated tool awaiting approval must not pin compute for hours, and a caller must never see a partial result.

**Model** — Approval state is explicit, and **approval events are the source of truth** for gated tool calls. For each gated `tool_use`, the runtime follows this state machine:

| State | Event / condition | Meaning |
|---|---|---|
| `requested` | assistant emits `tool_use` | Candidate tool call exists |
| `pending_approval` | `approval.requested` emitted, no `approval.resolved` yet | Call is blocked; run may pause |
| `denied` | `approval.resolved { approved: false }` | Call ends as denied; tool is not invoked |
| `approved` | `approval.resolved { approved: true }` or `approval.auto` | Call may proceed to dispatch |
| `executed` | `tool.called` emitted | Tool invocation started |
| `completed` | `tool.result` emitted | Terminal applied result recorded |

During tool dispatch, if `requireApproval` includes the tool name and the call has not been pre-approved, the runner invokes `ctx.requestApproval()`:

- On approval (`{ approved: true }`): continue to dispatch.
- On denial (`{ approved: false }`): emit a canonical error `tool_result` for that `tool_use` and continue the loop (no `tool.called` is emitted).
- On pause (`{ status: "pending" }`, production HITL): emit `approval.requested`, set run status to `"paused"`, and throw `RunPaused` carrying the pending approval id(s). The runtime catch boundary marks the run paused and (in a workflow) lets the signal unwind the handler. A `PausedResult` is available to callers that inspect the boundary instead of relying on the throw.

Providers may require a matching `tool_result` block in wire-format history to resume cleanly. Those **provider placeholders are transport-only artifacts**: they are not emitted as canonical `tool.result` events, are not indexed by idempotency projections, and never count as completed/applied tool calls.

**Replay on resume.** When a run resumes after a HITL pause or checkpoint:

1. Load the folded message history via `ctx.messages(agentName)`.
2. Read approval state from approval events (or the `approval_requests` projection): `approval.requested` without matching `approval.resolved` is pending approval.
3. For approved calls, re-dispatch through the normal path; idempotency short-circuits calls that already have a canonical terminal `tool.result`.
4. Denied calls resolve as canonical error `tool_result`s without invoking the tool.
5. Continue the loop from the next iteration.

**In-process approval modes.** When an agent runs in-process with no gateway to resolve approvals (local dev, `agent.run()` in a script), `requestApproval` follows the approval mode:

| Mode | Trigger | Behavior on a gated tool |
|---|---|---|
| **Auto-approve** (default) | (default) | Approves the call, but **logs it and emits an `approval.auto` event + sets an `approval.auto = true` span attribute** on the tool span. Never silent — it's auditable in traces. |
| **Strict** | `RENDER_AGENTS_STRICT_APPROVAL` set | Prompts on the terminal (`y/n`) when attached to a TTY. If non-interactive (no TTY), the run errors with `approval required, no resolver available`. |

This keeps local iteration fast by default while making the bypass visible, and lets you exercise real approval gates locally with one env var. The production (gateway) path is unaffected — it always enforces via `ApprovalRequest` + pause.

**Contract** — [`ApprovalResult`](05-type-reference.md#approvalresult), [`RunPaused`](05-type-reference.md#runpaused), [`PausedResult`](05-type-reference.md#pausedresult).

---

## Tool dispatch

**Purpose** — Every `tool_use` block the model emits is dispatched through one ordered sequence that enforces idempotency, approval, validation, tracing, and error containment.

**Model** — Tools are dispatched sequentially within a turn (parallel tool dispatch is a future optimization). For each `tool_use` block:

1. **Idempotency check** → call `ctx.appliedToolResult(toolCallId)` (a log lookup for a canonical terminal `tool.result`). If found, return it without re-executing. This makes checkpoint-resume and task retries safe for non-idempotent tools. "Already applied" means the call has a canonical terminal `tool.result` in the event log (success or canonical denial error), not a provider transport placeholder.
2. **Approval gate** → if `requireApproval` includes this tool name and the call is not in an approved state, invoke `ctx.requestApproval()` (full pause/resume mechanics in [HITL pause & resume](#hitl-pause--resume)).
3. **Lookup** → resolve the tool by name in the mounted tools map. Error result if unknown (e.g. the model hallucinated a tool not in `tools[]`).
4. **Validate input** → validate the model's input against the tool's `inputSchema` (applies to local *and* MCP-sourced tools, against the MCP-advertised schema). On failure, return an **error `tool_result`** with the validation message so the model can self-correct — the loop does not crash.
5. **Emit `tool.called`** → then call `tool.invoke(input, ctx)` with the tool context.
6. **Emit `tool.result`** → records the result in the log (which maintains the tool-calls idempotency projection and the tool span).
7. **Wrap** → return as a `tool_result` content block.

Errors in tool execution are caught and returned as `{ isError: true }` — they do not crash the loop. The model sees the error and can retry or handle it.

**Contract** — [`Tool`](05-type-reference.md#tool), [`ToolResult`](05-type-reference.md#toolresult).

---

## Event log & checkpoint

**Purpose** — The append-only event log is what makes a run inspectable and resumable. Resume is replaying the log, not loading a bespoke checkpoint.

**Model** — The runner emits events as it goes (`message.assistant`, `approval.*`, `tool.called`/`tool.result`, `message.tool`, `llm.call`); the store folds them into projections. To resume:

1. `ctx.messages(agentName)` returns the model-visible history, folded from `message.*`/`tool.*` events (post-compaction).
2. Pending approval is reconstructed from approval events: `approval.requested` without matching `approval.resolved`.
3. A started-but-incomplete tool execution is reconstructed as `tool.called` without matching canonical terminal `tool.result`.
4. On HITL pause, `run.paused` is appended; the log captures the interruption point.
5. On resume, approved pending calls are re-dispatched through the normal path; `appliedToolResult` short-circuits any call with a canonical terminal `tool.result` already in the log.

So the log answers "what did the model see, what ran, what is paused, what can resume?" in one place; spans (observability) and messages (execution) are both projections of it, not parallel stores.

When no durable store is available (in-memory mode for local dev), the log is held in memory and checkpoint-resume is not supported — runs are one-shot. This is a graceful degradation; the loop logic is identical.

**Contract** — [`RunEvent`](05-type-reference.md#runevent), [`EventLogStore`](05-type-reference.md#eventlogstore), [`Message`](05-type-reference.md#message).

---

## Structured output

**Purpose** — When an agent declares an `output` JSON Schema, the runner returns validated structured data alongside text, so composing agents pass typed `data` rather than parsing each other's prose.

**Model** — When an agent declares an `output` schema, the runner returns validated structured data in `AgentOutput.data` in addition to `text`:

1. On the final model turn, the runner sets `CompleteArgs.responseFormat = { type: "json_schema", schema }`. Providers with native structured output (e.g. OpenAI `response_format`, Anthropic tool/JSON modes) enforce it directly; providers without it fall back to a JSON instruction appended to the system prompt.
2. The returned content is parsed and validated against the schema. On success, `AgentOutput.data` is populated (and `text` holds the raw JSON). On validation failure, the runner retries up to a small bounded number of times (feeding the validation error back to the model); if it still fails, the run errors.
3. Agents **without** an `output` schema are unchanged: `data` is `undefined` and only `text` is returned.

The schema is part of the agent markdown, so structured output is portable and declared in one place.

**Contract** — [`AgentOutput`](05-type-reference.md#agentoutput), [`CompleteArgs`](05-type-reference.md#completeargs).

**Example:**

```ts
type Decision = { decision: "approve" | "reject"; reasons?: string[] };
const { data } = await ctx.agents.get("judge").run<Decision>({ findings });
if (data?.decision === "approve") { /* ... */ }
```

---

## Skill loading

**Purpose** — Skills use **progressive disclosure**: the model is told which skills exist and when to use them, but a skill's full `content` only enters the context window when the model explicitly loads it. This keeps the base system prompt small and pushes per-skill token cost to the runs that actually need it.

**Model:**

1. **Catalog in the system prompt.** During prompt assembly, for each skill in `AgentDefinition.skills` the runner appends a compact catalog entry — `id`, `name`, `description`, `whenToUse` — **not** the body. An agent with no declared skills gets no catalog and no skill tool.
2. **Built-in `load_skill` tool.** When an agent declares ≥1 skill, the runner auto-mounts a built-in tool alongside the agent's declared tools:

```ts
// Auto-mounted only when the agent declares skills. Not authored by the user.
const loadSkill: Tool = {
  name: "load_skill",
  description: "Load the full instructions for a declared skill by id.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string", description: "Skill id from the catalog" } },
    required: ["id"],
  },
  // invoke → returns the resolved skill's `content` as the tool_result
};
```

3. **On-demand load.** When the model decides a skill applies (guided by `whenToUse`), it calls `load_skill({ id })`. The runner looks the id up in the agent's resolved `skills` set and returns that skill's `content` as the `tool_result`, so the instructions land in the conversation like any other tool output and inform subsequent turns.
4. **Constrained to declared skills.** `load_skill` resolves **only** ids in the agent's declared `skills`. An undeclared or unknown id returns an **error `tool_result`** (the model can recover); it is not a crash. There is no way to load a skill the agent didn't declare.

Because `load_skill` is an ordinary tool, it inherits the [tool dispatch](#tool-dispatch) path for free — input validation, a `tool` span, and idempotency (loading the same skill twice in a run short-circuits to the stored result). Skills are read-only instruction content and never have side effects. `load_skill` is a reserved model-facing tool name; a user tool source that resolves to it is a load-time collision.

**Contract** — [`SkillMetadata`](05-type-reference.md#skillmetadata).

---

## Idempotency

**Purpose** — Tool calls and child-task dispatches must be safe to retry. On checkpoint-resume or task retry, neither should re-execute work that already produced a result.

**Model** — Idempotency is **one mechanism: "is it already in the log?"** Two keys, same question:

- **Tool-call key** `SHA-256(runId + toolCallId)` — `appliedToolResult` looks for an existing **canonical terminal** `tool.result` event; a hit short-circuits the dispatch. Dedupes *tool execution* within a run. Provider transport placeholders are excluded and never count as "already applied."
- **Dispatch key** `SHA-256(runId + agentName + callSeq)` (on `DispatchOptions`; see [Run vs task dispatch](#run-vs-task-dispatch)) — a matching `subagent.spawned`/child-run event short-circuits re-dispatch. Dedupes *child-task dispatch* so a resumed handler does not re-launch completed `agent.task()` runs.

There is no separate tool-call store: the `tool_calls` table is a projection that indexes `tool.result` events for these lookups.

**Contract** — [`idempotencyKey`](05-type-reference.md#idempotencykey), [`RunEvent`](05-type-reference.md#runevent).

---

## Cancellation

**Purpose** — Runs must be cancellable from outside the executing process. The gateway sets a cancel flag; the loop polls it cooperatively.

**Model** — The default implementation checks the `runs` row in Postgres (`status = 'cancelled'`). Cancel checks happen once per loop iteration, between LLM calls that take seconds — the ~5-10ms query overhead is negligible, and no KV dependency is required.

The loop checks `isCancelled` at the top of each iteration alongside budget checks. On cancellation, the run status is set to `"cancelled"` and the loop exits cleanly. Paused runs (HITL) can be cancelled directly by setting the DB status. The `CancelStore` interface allows swapping in a KV-backed implementation as a future optimization if needed.

**Contract** — [`CancelStore`](05-type-reference.md#cancelstore).

---

## Subagent delegation

**Purpose** — Subagents add *dynamic* composition: an agent declares which agents it may delegate to, and those are exposed to the model as tools it can call mid-loop. This is a built-in tool source backed by the runtime's dispatcher — it reuses `agent.task()`, tool idempotency, permissions/HITL, and tracing. (Static multi-agent composition happens in the workflow handler; authoring is in [Authoring → Subagents](01-authoring.md#subagents).)

**Model:**

- **Surface.** Each declared subagent becomes one resolved tool, `subagents__<name>`, whose description is the subagent's `description` (falling back to its name). The model calls it like any tool; input is the subagent's `AgentInput`, and the result is the subagent's `AgentOutput` (text + structured `data` when it declares an `output` schema) returned as the `tool_result`.
- **Execution.** Subagents run as **isolated tasks** by default (`agent.task()`): a chained Render Workflows run nested under the calling agent. Spans nest naturally — calling agent → `subagents__<name>` tool span → subagent agent span — so the trace tree shows the full delegation hierarchy. `userId` propagates to the subagent; cost rolls up into the root run's `totalCostUsd`.
- **Safety limits** (`DelegationLimits`, configured via `createRuntime({ delegation })` or env):
  - `maxDepth` (default 5) — a spawned subagent's run `depth` is its parent's `depth + 1`; a spawn that would exceed `maxDepth` returns an **error `tool_result`** (the model sees it; the loop doesn't crash).
  - `maxFanout` (default 50) — total subagent spawns across the whole root run tree; exceeding it returns an error `tool_result`.

Because spawning is just a tool call, it inherits idempotency (keyed on `toolCallId`, so resumes don't re-spawn), permission gating (`requireApproval: [subagents__researcher]`), and input validation.

**Contract** — [`DelegationLimits`](05-type-reference.md#delegationlimits).

---

## Hooks

**Purpose** — Hooks are the in-between extension point: lighter than a custom runner, they let you observe and gate the run without reimplementing the loop. Because everything the runtime does is an event, hooks are simply **subscribers/transformers on the event stream** — the natural place for cross-cutting concerns (logging/metrics, notifications, policy enforcement, loop/anomaly detection, context injection).

**Model** — Hooks are discovered from `hooks/` (auto-applied to all runs; see [Authoring → Hooks](01-authoring.md#hooks)) and may also be supplied via `createRuntime({ hooks })`. Each hook declares the event types/categories it reacts to via `on`. For every matching event, before it is appended, the hook's `handle` runs:

- **Observation** (the common case) → returns `{ action: "continue" }`; the event is appended unchanged. Side effects (emit a metric, post to Slack) happen here.
- **Transform** → returns `{ action: "continue", event }` with a rewritten event (e.g. redact a payload).
- **Veto** (gate categories like `tool`) → returns `{ action: "reject", reason }`. A rejected `tool.called` becomes an error `tool_result` the model can recover from — it does not crash the loop. This is how policy gates (allow-lists, destructive-command blocks) are enforced uniformly, complementing per-agent `requireApproval`.

Hooks run in registration order and must be fast and side-effect-isolated; a throwing hook is logged and treated as `continue` (fail-open for observers) except for gate hooks, which fail-closed. Hooks see the same events the SSE stream and projections do, so anything observable in a trace is hookable.

**Contract** — [`Hook`](05-type-reference.md#hook), [`HookResult`](05-type-reference.md#hookresult), [`HookContext`](05-type-reference.md#hookcontext), [`HookRegistry`](05-type-reference.md#hookregistry).
