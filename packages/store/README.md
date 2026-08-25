# @render-factory/store

The persistence substrate for [render-factory](../../README.md): the append-only
event log and the projections folded from it, with in-memory and Postgres
implementations behind one interface.

## Contents

- **`EventLogStore`** — `append` (single write path: assign `seq`, fold projections, NOTIFY), `read`, `tail` (live SSE).
- **Projections** — `runs`, `spans`, `run_messages`, `messages` (thread transcript), `tool_calls`, `workflow_steps`, `approval_requests`; all pure folds. `replay()` proves they're reconstructable from the log.
- **`RunStore`** — reads over the projections + `getApprovals`/`listApprovals`, plus `cleanup` (two-domain retention).
- **Threads** — `ThreadStore` (metadata + transcript).
- **OAuth** — `OAuthStore` with AES-256-GCM encryption at rest and single-flight refresh (`SELECT … FOR UPDATE` in Postgres).
- **`createStore()`** — auto-selects Postgres (`DATABASE_URL`) or in-memory.
- **`runRetention(store)`** — env-driven daily cleanup.

In-memory and Postgres are kept behavior-identical by a parity test suite (run with `TEST_DATABASE_URL`). Has no `@render-factory/*` dependencies (graph root).
