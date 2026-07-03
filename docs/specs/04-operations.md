# Operations

**Status:** IMPLEMENTED (living)
**Date:** 2026-07-02
**Layer:** L4 - deployment and runtime operations.

This layer documents how the system is deployed and operated today.

---

## Deployment Topology

Generated production topology (from `create-render-agents` blueprint):

1. **Gateway** (`web`)
   - HTTP front door, auth, SSE, scheduling/admin endpoints.
2. **Chat worker** (`worker`)
   - warm process draining `run_jobs` for interactive turns (`agent`/`resume`).
3. **Workflows host** (`worker`)
   - Render Workflows task registration and durable lane execution.
4. **Postgres**
   - event log, projections, queue, threads, OAuth, schedules.
5. **Crons**
   - retention (`/admin/retention`)
   - schedule tick (`/admin/schedules/tick`)
   - stranded-run reaper (`/admin/runs/reap`)

---

## Execution Mode

`RENDER_AGENTS_EXECUTION_MODE` controls root chat/resume execution:

- `inline` (default): trigger process drives execution immediately.
- `queue`: trigger process enqueues to `run_jobs`, worker drives execution.

`agent.task()` child dispatch always uses runtime dispatcher regardless of mode.

---

## Environment Variables

Operationally important env vars:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Select Postgres store/queue/delta/cancel backends |
| `PORT` | Gateway port |
| `RENDER_AGENTS_API_KEY` | Shared-key API auth material |
| `RENDER_AGENTS_EXECUTION_MODE` | `inline` or `queue` |
| `RENDER_AGENTS_ENCRYPTION_KEY` | OAuth token encryption + signing secret |
| `RENDER_AGENTS_COOKIE_SECRET` | Optional explicit cookie-signing secret for UI session |
| `RENDER_AGENTS_STRICT_APPROVAL` | Toggle strict approval in non-production |
| `RENDER_AGENTS_REQUIRE_WEBHOOK_VERIFY` | Require inbound webhook/connector signature verification (default on in production) |
| `RENDER_AGENTS_EVENT_RETENTION_DAYS` | Event-detail retention horizon |
| `RENDER_AGENTS_RUN_RETENTION_DAYS` | Run-summary retention horizon |
| `RENDER_AGENTS_RUN_STALE_MS` | Stale-root threshold for reaper |
| `RENDER_API_KEY` + `RENDER_WORKFLOW_SLUG` | Render root trigger wiring for workflow lane |
| `RENDER_SDK_SOCKET_PATH` / `RENDER_USE_LOCAL_DEV` | In-container/local Workflows detection |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | Model auto-detection |

Auth behavior notes:

- protected routes return `401` when key resolution fails,
- UI can authenticate via `/ui/login` cookie session when UI is enabled,
- SSE supports query key on allowlisted paths,
- inbound webhook/connector routes are public but signature-verified via each adapter's `verify` (fail-closed in production; see `01-authoring.md`).

---

## Local Development Modes

Typical paths:

1. **Gateway only + inline execution**
   - quickest path, no queue worker required.
2. **Gateway + Postgres**
   - persistent state locally.
3. **Queue mode + chat worker**
   - production-like lane B behavior.
4. **Workflows local-dev**
   - in-process fallback when Render runtime not available.

Scaffolder emits both host-style compose and full Docker stack files.

---

## Retention Model

Retention is split:

- **event detail horizon** (events + detail projections),
- **run summary horizon** (`runs`).

Thread metadata/transcripts and schedules are not auto-expired by retention cleanup.

Retention is executed via authed admin endpoint:

- `POST /admin/retention`

---

## Stranded-Run Reaping

`POST /admin/runs/reap` fails stale lane-A roots that:

- remain non-terminal,
- have no active queue job,
- have not emitted events within configured stale window.

This prevents permanently `running` roots when workflow host handoff fails to progress.

---

## Operational Endpoints

| Endpoint | Purpose |
|---|---|
| `POST /admin/retention` | retention cleanup |
| `POST /admin/runs/reap` | stranded root reaper |
| `POST /admin/schedules/tick` | due-schedule reconciliation |
| `GET /admin/jobs` | queue depth and job status counts |

---

## Practical NFR Baseline

The current implementation targets:

- Node 20+, ESM + strict TypeScript,
- equivalent semantics across memory and Postgres stores,
- replay-safe resumability and deterministic workflow-step behavior,
- no external observability dependency required for baseline trace/cost visibility.

