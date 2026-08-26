# Sprint 14 — Subagent Delegation

**Status:** DRAFT
**Wave:** 2 — Orchestration & Durability
**Depends on:** 07 (tool dispatch path), 11 (task dispatch)
**Unblocks:** —

---

## Goal

Add dynamic composition: an agent declares which agents it may delegate to (`subagents:` frontmatter), and each becomes a built-in `subagents__<name>` tool the model can call mid-loop — backed by the runtime dispatcher, reusing `agent.task()`, tool idempotency, permissions/HITL, and tracing, with depth/fan-out safety limits.

---

## Foundational decisions in play

- [D6](../specs/00-foundations.md#d6--tools-are-declared-per-agent-tools-is-the-sole-allowlist-mcp-at-the-boundary) — subagents are a declared, allowlisted tool source; the model can only delegate to declared agents.
- [D2](../specs/00-foundations.md#d2--one-execution-model-run-vs-task-is-a-method-call-not-config) — delegation reuses `agent.task()` (isolated chained run), same output shape.

---

## Scope

**In:**
- **Subagent tool source:** each declared `subagents: [name, ...]` entry (resolved against the AgentSet in Sprint 02) becomes one resolved tool `subagents__<name>`, whose description is the subagent's `description` (fallback to name).
- **Surface:** the model calls it like any tool; input is the subagent's `AgentInput`; result is the subagent's `AgentOutput` (text + structured `data` when it declares `output`) returned as the `tool_result`.
- **Execution:** subagents run as **isolated tasks** by default (`agent.task()`) — a chained Render Workflows run nested under the caller.
- **Trace nesting:** caller agent → `subagents__<name>` tool span → subagent `agent` span (depth+1); the delegation hierarchy is visible (Sprint 10 tree). The subagent `agent` span lives in the **child run**; the cross-run tree is stitched via `subagent.spawned.childRunId` at the read layer (not a single `listSpans`).
- **Identity + cost:** `userId` propagates to the subagent. The subagent runs as its **own child run** with its own `totalCostUsd`; the caller's "all-in" cost is a **read-layer aggregate** over `subagent.spawned.childRunId` (root + recursive children), *not* a fold into the root run's per-run `totalCostUsd`.
- **Safety limits (`DelegationLimits`, via `createRuntime({ delegation })` or env):**
  - `maxDepth` (default 5): a spawn that would exceed it returns an **error `tool_result`** (no crash); `depth` = parent depth + 1.
  - `maxFanout` (default 50): total spawns across the whole root run tree; exceeding returns an error `tool_result`.
- **Inherited mechanics:** because spawning is a tool call, it inherits idempotency (keyed on `toolCallId`, so resume doesn't re-spawn), permission gating (`requireApproval: [subagents__researcher]`), and input validation — all for free from Sprint 07/13.

**Out:**
- New dispatch machinery — reuses the Sprint 11 dispatcher.
- New approval machinery — reuses the Sprint 13 gate.
- Static multi-agent composition (that's the workflow handler, Sprint 12).

---

## Deliverables

`@render-factory/engine` (+ sdk surface):
- Built-in subagent `ToolSource` factory that, given an agent's `subagents`, produces `subagents__<name>` tools bound to the dispatcher.
- Depth/fan-out enforcement against `DelegationLimits` (run-tree-wide fanout counter; per-run depth).
- `subagent.spawned` event emission + trace nesting (`parentSpanId`/`depth` propagation through `DispatchOptions`).
- Read-layer cost aggregation across the run tree (root + child runs via `subagent.spawned.childRunId`) + verification.

---

## Porting source

- **New** — the subagent tool source is new code, but it's *thin*: it composes Sprint 11's dispatcher + Sprint 07's dispatch path. No direct template/harness source. The template's multi-agent workflows are reference for fan-out ergonomics only.

---

## Implementation notes

1. **It's just a tool.** Implement `subagents__<name>` as a `ToolSource` whose `invoke` calls `dispatcher.dispatch(name, input, opts)` (or `agent.task` semantics) with `depth = ctx.depth + 1`, `userId = ctx.userId`, `parentSpanId =` the tool span. Everything else (idempotency, validation, approval, tracing) comes from the dispatch path.
2. **Fanout is run-tree-wide**, not per-agent: track total spawns across the entire root run (a counter folded from `subagent.spawned` events). Depth is per branch.
3. **Limit breaches are recoverable:** exceeding `maxDepth`/`maxFanout` returns an error `tool_result` the model sees — it does not crash the run.
4. **`subagent.spawned` drives the trace tree** (delegation category) and the dispatch-idempotency lookup (so a resumed parent doesn't re-spawn a completed child).
5. **Structured output passthrough:** when a subagent declares an `output` schema, surface its `data` in the `tool_result` so the caller model gets typed results, not just prose.

---

## Exit criteria / acceptance

- An agent with `subagents: [researcher]` exposes a `subagents__researcher` tool; calling it runs the researcher as a nested task and returns its `AgentOutput` (text + `data`).
- The trace shows caller → `subagents__researcher` tool span → researcher agent span at depth+1 (stitched across runs via `subagent.spawned.childRunId`); the read-layer aggregate cost (root + child runs) equals the sum of `llm.call` costs across the tree.
- `userId` propagates to the subagent (verifiable via an OAuth-dependent tool once Sprint 19 lands; until then via the run record).
- Exceeding `maxDepth` or `maxFanout` returns an error `tool_result` (no crash).
- A resumed parent run does not re-spawn an already-completed subagent (dispatch idempotency).
- `requireApproval: [subagents__researcher]` gates the spawn through the HITL path (Sprint 13).

---

## Risks / open questions

- **Fanout accounting under parallelism:** concurrent spawns racing on the run-tree counter — fold from events (authoritative) rather than an in-memory counter to avoid races across containers.
- **Depth across process boundaries:** `depth` must propagate via `DispatchOptions` into the child container (it's not inferrable locally); verify it survives dispatch.
- **Cost aggregation timing:** child cost is known only when the child completes. Resolved model: each run's `totalCostUsd` stays a per-run fold; the delegating run's all-in cost is computed at **read time** by summing child runs discovered via `subagent.spawned.childRunId` (recursively). This avoids cross-run writes into the root projection and is naturally correct once children finish; an in-progress aggregate simply reflects children completed so far.
