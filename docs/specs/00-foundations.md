# render-agents — Foundations

**Author:** Jacob Prall
**Status:** DRAFT
**Date:** 2025-06-25

This is the **Foundations** layer (L0) of the render-agents technical specification. It establishes why the SDK exists and the load-bearing decisions everything else derives from. 

See the [Document Map](#document-map) for the full file set.

---

## Objective

### North star

A software engineer defines agents as markdown files, composes them into pipelines with TypeScript, and deploys the result on Render with one config file. The SDK provides the authoring model, execution kernel, tool system, observability, and platform substrate. The agent loop is pluggable. Everything else is opinionated.

### Scope

| In scope | Out of scope |
|---|---|
| TypeScript SDK (`@render-agents/sdk`) | Python SDK (future, same platform contract) |
| Markdown agent authoring + validation | GUI/visual agent builder |
| In-process and Workflow-dispatched execution | Non-Render orchestration backends |
| Local tools and MCP tool sources | Custom tool protocols beyond MCP |
| OTel-shaped tracing to Postgres | Third-party collector integrations (export only) |
| Web gateway with sessions, HITL, OAuth | End-user-facing chat UI |
| Render Workflows as the orchestration primitive | Generic workflow engine abstraction |

---

## Foundational Decisions

The decisions below are load-bearing: each imposes an invariant that many downstream contracts depend on. If one changes, expect its blast radius to change with it. Everything later in the spec is derived from these.

### D1 — Markdown is the agent
**Decision:** An agent is a single `.md` file: YAML frontmatter (config) + body (system prompt).
**Why:** Human-readable, diffable, portable, self-contained; no build step to understand an agent.
**Invariant:** Agent identity and config live in the file, not a registry or code.
**Blast radius:** Agent authoring schema, the loader/validation, `_shared.md` merge, scaffolder.

### D2 — One execution model: `run` vs `task` is a method call, not config
**Decision:** `agent.run()` runs in-process; `agent.task()` dispatches an isolated Render task. Same definition, same output shape.
**Why:** Removes the harness's "which runtime?" decision; the same agent runs locally and in production unchanged.
**Invariant:** Local = production; choosing isolation is a call site, never a separate deployment shape.
**Blast radius:** `Agent` API, dispatch, deployment model, testing.

### D3 — Render Workflows is per-task durable, not deterministic-replay
**Decision:** Durability is per task (run-once; retry = full re-run). There is no Temporal-style memoized replay.
**Why:** It's what the platform provides; we don't fake a replay engine.
**Invariant:** Handlers must be deterministic; side effects go in `ctx.step()` or `agent.task()`; root `retries` default to 0.
**Blast radius:** Handler determinism contract, `ctx.step`, `workflow_steps`, dispatch idempotency keys, retries semantics, resume.

### D4 — Workflows orchestrate, Postgres persists
**Decision:** Workflows answer "what runs next?"; Postgres answers "what happened, what was seen, what's paused, what can resume?"
**Why:** Orchestration state and agent/run state are different responsibilities; conflating them loses inspectability and retry-safety.
**Invariant:** Run messages, tool calls, approvals, steps, and traces are persisted; resume is driven from Postgres, not handler memory.
**Blast radius:** Store schema, checkpoint/resume, `RunContext`, observability.

### D5 — Injectable runtime / composition root
**Decision:** A single `AgentRuntime` (model, store, tracer, runners, dispatcher), built by `createRuntime()` and bound via `loadAgents(dir, runtime)`. No global singleton.
**Why:** Same wiring across gateway and workflow service; makes local dev and testing trivial (swap the model/store).
**Invariant:** Agents acquire all dependencies from the runtime they're bound to; nothing is wired per call.
**Blast radius:** `createRuntime`/`AgentRuntime`, `loadAgents`, `ctx.agents`, testing utilities, dispatcher fallback.

### D6 — Tools are declared per-agent; `tools[]` is the sole allowlist; MCP at the boundary
**Decision:** Agents explicitly declare tools; only declared tools are mounted/presented. Local tools for convenience, MCP for cross-language/production isolation. No allow/deny lists.
**Why:** Convention over configuration; nothing is injected globally, so there's nothing to ban.
**Invariant:** The model can only ever call tools the agent declared; `requireApproval` matches resolved tool names.
**Blast radius:** Tool system, discovery/collisions, permissions, namespacing, subagents tool.

### D7 — HITL pause is a control-flow signal resolved by replay
**Decision:** A gated tool awaiting approval throws `RunPaused`, which unwinds the handler; the run resumes by re-executing with completed work replayed.
**Why:** A paused run must not pin compute for hours; callers must never see a partial result.
**Invariant:** Downstream code never runs without a needed result; resume = re-execute + replay (depends on D3/D4).
**Blast radius:** `ApprovalResult`, runner contract, gateway resume, store.

### D8 — Observable by default; every unit is a span; Postgres is source of truth
**Decision:** Workflow runs, steps, agents, LLM calls, and tool calls are all spans, written to Postgres; OTel export is optional.
**Why:** "What happened and what did it cost" must work with zero setup.
**Invariant:** No execution path is untraced; full visibility requires no external collector.
**Blast radius:** Tracer, store schema, cost attribution, gateway trace UI.

### D9 — The runner is pluggable; `RunContext` is the full platform contract
**Decision:** The agent loop is an interface; `RunContext` carries HITL, budget, tracing, streaming, persistence, cancellation, and tool mounting — not just the prompt.
**Why:** Teams can bring their own loop without losing platform behavior.
**Invariant:** Custom runners that honor `RunContext` keep all platform guarantees; ones that skip hooks degrade gracefully.
**Blast radius:** Runner interface, engine, `RunContext`, gateway integration.

---

## Architecture at a Glance

The SDK is a pnpm + Turborepo monorepo of four runtime packages plus a scaffolder. Detailed per-file layout is an implementation concern; the contracts each package owns live in the [Type Reference](05-type-reference.md).

| Package | Responsibility |
|---|---|
| `@render-agents/sdk` | Public API surface: `createRuntime`, `loadAgents`, `workflow`, `defineTool`/`defineMcpSource`, testing utilities, all public types |
| `@render-agents/engine` | Default runner + LLM loop, model clients, model tiers, environment/tool mounting, skill loading |
| `@render-agents/store` | Persistence: Postgres + in-memory `RunStore`, span tracer |
| `@render-agents/gateway` | Web service: routes, sessions, HITL, OAuth, SSE streaming, webhook dispatch |
| `create-render-agent` | `npm create` scaffolder (no runtime deps) |

**Dependency graph:**

```
@render-agents/sdk
  └── @render-agents/engine  (default runner, re-exported)
  └── @render-agents/store   (tracer + store, re-exported)

@render-agents/gateway
  └── @render-agents/sdk
  └── @render-agents/store
```

**Build + publish:** strict TypeScript, `NodeNext` resolution, declaration emit; Node 20+, ESM only; each `packages/*` publishes independently to npm.

---

## Document Map

The spec is split into layered files. Read top to bottom for the full picture; jump to the Type Reference for exact shapes.

| File | Layer | Contents |
|---|---|---|
| [`00-foundations.md`](00-foundations.md) | Foundations | Objective, principles, foundational decisions, architecture at a glance, glossary, this map |
| [`01-authoring.md`](01-authoring.md) | Authoring | Project layout & discovery, agent markdown schema, tools, skills, workflows, subagents, authoring API |
| [`02-execution.md`](02-execution.md) | Execution | Runtime & composition, the loop, run/task dispatch, determinism & replay, HITL, budgets, structured output, idempotency, cancellation |
| [`03-platform.md`](03-platform.md) | Platform | Store & Postgres schema, sessions, OAuth, webhooks/connectors/schedules, gateway, observability |
| [`04-operations.md`](04-operations.md) | Operations | Deployment, configuration, retention, non-functional requirements |
| [`05-type-reference.md`](05-type-reference.md) | Reference | Every `interface`/`type` definition (pure catalog, linked from the layers above) |
| [`porting-map.md`](porting-map.md) | Appendix | Code provenance / lift-and-shift map from the source repos |
| [`future-considerations.md`](future-considerations.md) | Appendix | Sandboxes and other forward-looking extensions |
