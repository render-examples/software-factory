# render-agents Foundations

**Status:** IMPLEMENTED (living)
**Date:** 2026-07-02

This document is the overview of the `render-agents` monorepo. It defines package ownership, architecture boundaries, and the invariants the rest of `docs/specs/` builds on.

---

## What this system is

`render-agents` is a TypeScript platform for building and operating agent systems on Render:

- Agents are markdown files in `agents/*.md`.
- Workflows are TypeScript handlers in `workflows/*/index.ts`.
- Runtime execution is shared across local dev and production via `createRuntime()`.
- Durable state lives in Postgres (or memory in dev/tests), centered on an append-only event log.
- The gateway provides threads, approvals, OAuth, scheduling, and SSE.

The implementation is in five runtime packages plus one scaffolder:

| Package | Purpose |
|---|---|
| `@render-agents/sdk` | Public composition API: runtime creation, loading, workflow binding, dispatch, worker |
| `@render-agents/engine` | Agent loop, tool runtime, model clients, context compaction, run context |
| `@render-agents/store` | Event log, projections, Postgres/memory stores, queues, delta bus, retention |
| `@render-agents/gateway` | HTTP/API layer, auth, threads, approvals, OAuth, schedules, SSE, UI serving |
| `create-render-agents` | Project generator (`npm create`) and deployment blueprint |

---

## Package Module Map

The following modules are the practical ownership boundaries to use when editing behavior.

### `@render-agents/sdk`

- `src/runtime.ts`: `createRuntime`, dependency auto-detection, composition root.
- `src/agents.ts`: `loadAgents`, bound `Agent` handles, `driveAgentTurn`, `resumeRun`.
- `src/workflow.ts`: `workflow()`, `bindWorkflow`, deterministic `ctx.step()` replay.
- `src/dispatch.ts`: in-process and Render Workflows dispatchers + task handlers.
- `src/worker.ts`: warm worker loop for `run_jobs` (`agent` and `resume` kinds).
- `src/submit.ts`: inline-vs-queue root execution fork.
- `src/loader/*`: project convention discovery and validation.

### `@render-agents/engine`

- `src/default-runner.ts`: core agent loop.
- `src/run-context.ts`: event emission, approvals, cancellation checks, thread history, OAuth, deltas.
- `src/tool-impl.ts`: `defineTool`, `defineMcpSource`, `ToolEnvironment`.
- `src/subagent-source.ts`: dynamic `subagents__*` tools and delegation limits.
- `src/context-manager-impl.ts`: auto compaction implementation.
- `src/clients/*`: Anthropic/OpenAI clients and retry behavior.

### `@render-agents/store`

- `src/events.ts`: event taxonomy and event-store contracts.
- `src/projections.ts`: fold logic from events to projections.
- `src/memory-store.ts` and `src/pg/postgres-store.ts`: store backends.
- `src/job-queue.ts` + `src/pg/job-queue.ts`: durable queue for chat lane.
- `src/delta-bus.ts` + `src/pg/delta-bus.ts`: transient token streaming channel.
- `src/retention.ts`: retention and stranded-run reaping.
- `sql/*.sql`: migration source of truth.

### `@render-agents/gateway`

- `src/app.ts`: app assembly and lane routing.
- `src/auth.ts` + `src/ui-session.ts`: bearer auth, cookie session auth for UI.
- `src/routes/*.ts`: runs, stream, threads, HITL, OAuth, schedules, webhooks, UI.
- `src/connector.ts`: package-contributed connector loading from `tools/*`.
- `ui/src/*`: operator UI implementation.

### `create-render-agents`

- `src/index.ts`: CLI flow and argument handling.
- `src/blueprint.ts`: generated project files and default topology.
- `src/write.ts`: file emission with path-safety checks.

---

## Load-Bearing Decisions

1. **Markdown-first agent definitions**
   - Agents are single files with frontmatter + prompt body.
   - Parsing and validation happen in `packages/sdk/src/loader`.

2. **One agent execution interface**
   - `agent.run()` and `agent.task()` share definitions and output shape.
   - Isolation is a call-site choice, not a separate authoring format.

3. **Two root execution lanes**
   - Lane A: workflow roots dispatch through Render Workflows (`dispatchRoot`).
   - Lane B: interactive thread turns flow through `run_jobs` + warm worker.

4. **Event log as canonical runtime history**
   - `run_events` is the durable source of truth.
   - `runs`, `spans`, `messages`, approvals, tool calls, and steps are projections.

5. **Composition-root runtime**
   - `createRuntime()` wires store/model/dispatcher/runners/hooks once.
   - Services share the same runtime shape (gateway, worker, workflow host).

6. **Tool allowlisting by agent definition**
   - Agent `tools` declarations govern model-callable capabilities.
   - Approval gates (`requireApproval`) are enforced at dispatch time.

7. **Pause/resume by replay**
   - Approval and input pauses become `run.paused`.
   - Resume re-drives from logged state; no ad hoc checkpoint state.

8. **Observability from the same event stream**
   - Spans and costs are folded from emitted events.
   - No separate tracing persistence path.

9. **Transient token deltas**
   - `text.delta` is streamed through `DeltaBus`, never persisted in `run_events`.

---

## Architecture At A Glance

```text
triggers (http/webhook/cron/chat)
        |
      gateway
   (front door + SSE)
      /      \
Lane A      Lane B
workflow    run_jobs queue
roots       (agent/resume)
via         warm worker
dispatchRoot
      \      /
       shared store
   (event log + projections)
```

---

## Document Map

| File | Layer | Focus |
|---|---|---|
| `00-foundations.md` | Foundations | Package ownership and architecture invariants |
| `01-authoring.md` | Authoring | Project structure, markdown/frontmatter, discovery, loaders |
| `02-execution.md` | Execution | Runtime behavior, loop semantics, replay, dispatch |
| `03-platform.md` | Platform | Persistence model, gateway contracts, streams, operational tables |
| `04-operations.md` | Operations | Deployment topology, env configuration, retention, ops endpoints |
| `05-type-reference.md` | Reference | Public API and type ownership map |
| `06-operator-ui.md` | Operator UI | Implemented console behavior and backend dependencies |
| `porting-map.md` | Appendix | Implementation ownership map for contributors |
| `future-considerations.md` | Appendix | Non-implemented extension seams |

