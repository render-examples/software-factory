# Sprint 16 — Gateway Core (Hono, Run Routes, Auth)

**Status:** DRAFT
**Wave:** 3 — Platform & Serving
**Depends on:** 10 (spans/cost projections), 12 (workflow dispatch), 13 (`CancelStore` for the cancel route)
**Unblocks:** 17, 18, 19, 20 (all build on the gateway)

---

## Goal

Stand up the `@render-factory/gateway` web service on Hono with the core run-facing routes (dispatch a workflow, list/inspect runs, spans, tool-calls, cancel), API-key bearer auth, and the shared composition (`createRuntime` + `loadAgents` at startup) — the single entry point for triggering and observing work.

---

## Foundational decisions in play

- [D5](../specs/00-foundations.md#d5--injectable-runtime--composition-root) — the gateway and workflow service construct the *same* `AgentRuntime` via `createRuntime()`.
- [D8](../specs/00-foundations.md#d8--observable-by-default-every-unit-is-a-span-postgres-is-source-of-truth) — run/span/tool-call reads are projections of the log served over HTTP.

---

## Scope

**In:**
- **Hono app** + server bootstrap: `createRuntime()` + `loadAgents()` once at startup; `RunStore.init()`; `PORT` from env.
- **Core routes** ([Platform → Gateway](../specs/03-platform.md#gateway)):
  - `POST /workflows/:name` — dispatch a workflow run (→ `WorkflowDefinition.dispatch`, Sprint 12).
  - `GET /runs` — list runs, keyset pagination via `before`.
  - `GET /runs/:id` — run details + messages.
  - `GET /runs/:id/spans` — span tree.
  - `GET /runs/:id/tool-calls` — tool calls + results.
  - `POST /runs/:id/cancel` — cancel a running/paused run (→ `CancelStore`, Sprint 13).
  - `GET /health`.
- **API-key bearer auth** (`Authorization: Bearer <key>`, `RENDER_FACTORY_API_KEY`): constant-time compare, fail-closed on missing key.
- **Input validation** on routes: non-empty inputs, agent/workflow name resolution, clear 4xx errors.
- **Serialization** of `RunRecord`/`SpanRecord`/messages/tool-calls to JSON response shapes.

**Out:**
- SSE streaming + threads (Sprint 17).
- Approvals + HITL resume routes (`/approvals`, `/runs/:id/input`) (Sprint 18).
- OAuth routes (Sprint 19); webhooks/connectors (Sprint 20).
- The dev trace viewer SPA (Sprint 22) — these routes are what it reads.

---

## Deliverables

`@render-factory/gateway`:
- Hono app + startup composition (runtime, agents, store init).
- The core run routes above + serializers.
- API-key auth middleware (constant-time, fail-closed).
- Route-level input validation + error mapping.

---

## Porting source

- **T — Gateway + webhooks:** `agent-workflows-template/src/main.ts`, `src/server/` — adapt to Hono; this sprint takes the run routes; threads/HITL/OAuth/schedules come from the harness in later sprints.
- **H — API key auth:** `render-agent-harness/.../web/src/auth.ts` — port constant-time compare + fail-closed.
- **H — Run routes / serializers:** `web/src/routes/runs.ts`, `web/src/serializers.ts`, `web/src/summary.ts` — port the list/detail/spans/tool-calls read routes (SSE handler deferred to Sprint 17); adapt reads to the projection store.
- **H — Input validation:** `web/src/routes/*.ts` — port non-empty input + name-resolution validation patterns.

---

## Implementation notes

1. **One composition root, two services:** the gateway builds the same `AgentRuntime` as the workflow service ([D5](../specs/00-foundations.md#d5--injectable-runtime--composition-root)). Dispatching a workflow from the gateway uses `WorkflowDefinition.dispatch` (which triggers the Render Workflows root task or, locally, runs in-process).
2. **Reads are projection reads** — `GET /runs*` map directly onto `RunStore` methods (`listRuns`, `getRun`, `getMessages`, `listSpans`, `getToolResult`/tool-calls projection). No new query paths. Note `getRun`/`listSpans` are **per-run**; for a delegating run, all-in cost and the cross-run delegation tree are a **read-layer aggregate** over child runs (via `subagent.spawned.childRunId`, per Sprints 10/14) — the gateway/viewer composes it, the store stays per-run.
3. **Auth is fail-closed:** missing/empty `RENDER_FACTORY_API_KEY` config or missing bearer → 401; constant-time compare to avoid timing leaks.
4. **Keep routes thin:** validation + store/dispatch calls + serialization. Business logic stays in the runtime/store.
5. **Cancel route** sets the `CancelStore` flag (Sprint 13); the loop picks it up cooperatively.

---

## Exit criteria / acceptance

- `POST /workflows/:name` dispatches a run and returns its `RunRecord`/run id; an unknown workflow → 404; bad input → 400.
- `GET /runs` paginates via `before`; `GET /runs/:id` returns run + messages; `/spans` returns the tree; `/tool-calls` returns inputs/results.
- `POST /runs/:id/cancel` transitions a running/paused run to `cancelled`.
- `GET /health` returns OK; all data routes require a valid bearer key (401 otherwise), constant-time compared.
- The gateway boots: runtime built, agents loaded, store migrated.

---

## Risks / open questions

- **Dispatch from gateway vs workflow service:** confirm `dispatch` from the gateway correctly triggers the Render Workflows root task (vs in-process) based on env; the two services share wiring but only the workflow service hosts task handlers.
- **Large run payloads:** `GET /runs/:id` with long histories — paginate/limit messages; rely on projections, not full event reads.
- **Hono + Render web service specifics:** confirm Hono server adapter for Node/Render, graceful shutdown (close store/LISTEN clients).
