# Architecture

A concise tour of how render-agents fits together. The normative contract is the
[layered spec](specs/00-foundations.md); this is the orientation map.

## The keystone: an append-only event log

Every run is a stream of events appended to `run_events` ([D10](specs/00-foundations.md#d10--the-append-only-event-log-is-the-single-source-of-truth)).
Everything else is a **projection** — a pure fold of that log:

```
run_events  ──fold──▶  runs        (status, cost, trigger, thread_id)
            ──fold──▶  spans       (the observability tree, via parentId)
            ──fold──▶  run_messages(per-agent LLM history)
            ──fold──▶  messages    (human-facing thread transcript)
            ──fold──▶  tool_calls  (idempotency index)
            ──fold──▶  workflow_steps (ctx.step memoization)
            ──fold──▶  input_requests (HITL state)
```

`events.append` is the single write path: it assigns a gap-free `seq`, folds the
projections (in one Postgres transaction), and notifies SSE tails — atomically.
Reads never touch a bespoke store; they query a projection. Replay from the log
reconstructs every projection byte-for-byte (proven by the parity suite).

## Layers & packages

```
┌──────────────────────────────────────────────────────────┐
│ @render-agents/gateway  — Hono: runs, SSE, HITL, OAuth,    │
│                            webhooks, /ui, /admin/retention │
├──────────────────────────────────────────────────────────┤
│ @render-agents/sdk      — authoring (markdown → AgentSet), │
│   loadAgents/loadWorkflows/loadToolSources, createRuntime, │
│   workflow(), dispatch (run vs task), resumeRun            │
├──────────────────────────────────────────────────────────┤
│ @render-agents/engine   — the agent loop (DefaultRunner),  │
│   RunContext, tools/skills, model clients, context mgmt    │
├──────────────────────────────────────────────────────────┤
│ @render-agents/store    — EventLogStore + projections,     │
│   memory + Postgres, threads, OAuth, retention             │
└──────────────────────────────────────────────────────────┘
```

Dependency graph is acyclic: `store ← engine ← sdk`; `gateway → {sdk, store}`.
CI enforces it (engine/store never import sdk; store never imports engine).

## Runtime composition (D5)

`createRuntime()` is the composition root: it auto-detects the store (Postgres
when `DATABASE_URL` is set, else in-memory), the model client (from provider
keys), and the dispatcher (Render Workflows when the workflow socket is present,
else an in-process fallback with identical observable behavior). The gateway and
the workflow service build the runtime identically.

## Execution: run vs task (D2)

- `agent.run(input)` executes the loop **in-process**, within the caller's span tree.
- `agent.task(input)` dispatches an **isolated, durable** child run (Render Workflows
  in production; in-process locally). Same `AgentDefinition`, same output shape.
- Workflows (`workflow(handler)`) compose agents + deterministic `ctx.step()`s; step
  results are memoized via `step.completed` events so handler replay is idempotent.

## HITL & resume

A gated tool emits `input.requested` + `run.paused` and the loop unwinds. An
operator resolves it out-of-band (`POST /inputs/:id/provide`); the gateway then
**re-drives** the run (`resumeRun`) — the loop's `hasStarted()` guard + pending-tool
replay continue from the logged state. Resolved inputs and applied tool results
short-circuit on replay, so resume is idempotent.

## Threads

A thread spans many runs. Each turn's run carries `thread_id`/`user_id` (propagated
down to child agent runs), so the human-facing transcript (`messages`) and the thread
SSE stream capture the whole conversation. A partial unique index enforces at most one
active run per thread (`409 thread_busy`).

## OAuth

Per-user tokens are stored encrypted at rest (AES-256-GCM). Tools read them via
`ToolContext.connection(provider)`, which resolves (and single-flight refreshes, via
`SELECT … FOR UPDATE`) the current token. OAuth state is HMAC-signed and verified in
constant time.

## Observability & retention

Spans are a projection; the dev viewer at `/ui` is a pure read layer over the run/span/
SSE routes. Retention is two-domain: high-volume event detail (30d default) is trimmed
ahead of low-volume run summaries (90d default); thread transcripts and schedules are
never auto-expired.
