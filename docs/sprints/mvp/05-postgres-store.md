# Sprint 05 — Postgres Store: Event Log, Projections, Migrations, NOTIFY

**Status:** DRAFT
**Wave:** 1 — Core Execution Engine
**Depends on:** 03 (event log + memory store + folders)
**Unblocks:** 11 (durable dispatch), 13 (checkpoint/resume), 16/17 (gateway reads + SSE)

---

## Goal

Implement the durable Postgres `RunStore` and `EventLogStore`: the canonical `run_events` table plus all maintained projections, applied via idempotent migrations under an advisory lock, with the same projection folders from Sprint 03 and real `LISTEN/NOTIFY` for the tail. After this sprint, runs are durable and resumable, and memory↔Postgres behavior is at parity.

---

## Foundational decisions in play

- [D4](../specs/00-foundations.md#d4--workflows-orchestrate-postgres-persists) — Postgres holds the append-only event log; resume is driven from the log.
- [D10](../specs/00-foundations.md#d10--the-append-only-event-log-is-the-single-source-of-truth) — `events.append` atomically inserts the event, updates projections, and `NOTIFY`s the stream.

---

## Scope

**In:**
- **Schema** exactly per [Platform → Store & Postgres schema](../specs/03-platform.md#store--postgres-schema): `run_events` (canonical) + projections `runs`, `spans`, `tool_calls`, `run_messages`, `approval_requests`, `workflow_steps`, plus operational tables `sessions`, `threads`, `messages`, `oauth_connections`, `schedules`. All `CREATE TABLE IF NOT EXISTS`, all specified indexes (including the partial unique `idx_runs_thread_active`).
- **Migration runner:** `RunStore.init()` applies migrations under a **Postgres advisory lock**, in the canonical **dependency order** (sessions → threads → runs → run_events → projections/ops → messages → oauth_connections) so all FKs resolve. Idempotent + safe under concurrent boot.
- **`events.append` as a single transaction:** insert into `run_events` (assign gap-free `seq` via `next_seq`-style ordering), update affected projections (reuse Sprint 03 folders, translated to SQL upserts), `NOTIFY` with a pointer payload `{ runId, seq }`.
- **`EventLogStore.tail`:** dedicated `pg.Client` holding `LISTEN run_events`; on NOTIFY, fetch the event by `(runId, seq)` and yield; supports resume-from-`seq` and filtering by `runId`/`threadId`.
- **`RunStore` projection reads** backed by SQL: `getRun`, `listRuns` (keyset pagination via `before`), `getMessages`, `listSpans`, `getStepResult`, `getToolResult`.
- **Store auto-detection wired into `createRuntime`:** `DATABASE_URL` present → Postgres; absent → in-memory (completes the Sprint 04 seam).
- **Memory↔Postgres parity test suite:** the same scripted event sequences produce identical projection reads in both stores.

**Out:**
- Token-level `text.delta` streaming (post-MVP; Sprint 17 streams `message.assistant`).
- The SSE HTTP endpoint (Sprint 17) — this sprint delivers `tail`; the route consumes it.
- Retention/cleanup job (Sprint 23).
- Session/approval/oauth *runtime behavior* (Sprints 17–19) — the tables exist here; their routes come later. The `SessionStore`/`ApprovalStore`/`OAuthStore`/`ScheduleStore` **interfaces are owned by `@render-agents/store`** (Sprint 01), so their Postgres implementations belong in this package; they may be stubbed against these tables now or filled in alongside their gateway routes (Sprints 17–19) — see notes.

---

## Deliverables

`@render-agents/store`:
- SQL migration files (or in-code DDL) + advisory-lock migration runner.
- Postgres `EventLogStore` (`append`/`read`/`tail`).
- Postgres `RunStore` reads over projections.
- Pointer-payload `NOTIFY` on append + `LISTEN`-based `tail` with reconnect/`seq` resume.
- Parity test harness running the Sprint 03 store-contract suite against both memory and Postgres (Testcontainers or a CI Postgres service).

---

## Porting source

- **H — Migrations + advisory lock:** `render-agent-harness/.../core/src/state/schema.ts`, `core/sql/*.sql` — port the advisory-lock pattern + idempotent `CREATE TABLE IF NOT EXISTS` + index naming. Adapt table schemas to the spec ([Keep the SQL](../specs/porting-map.md#4-porting-principles)).
- **H — Run state repo / NOTIFY:** `core/src/state/repo.ts` — port `next_seq()` → event-log `seq`; status/message folds → projections maintained on `events.append`; NOTIFY-per-append.
- **H — SSE NOTIFY mechanics:** `web/src/routes/runs.ts` (SSE handler) + repo NOTIFY — port the **pointer-payload** NOTIFY + dedicated `pg.Client` LISTEN pattern, pointed at `run_events`.
- **T — Postgres store:** `agent-workflows-template/src/engine/store/postgres.ts` — reference; supersede its direct-write model with the event-log fold.

---

## Implementation notes

1. **Reuse the folders, not new logic.** The Sprint 03 projection folders define *what* each projection contains; the Postgres path applies the same fold as SQL upserts inside the append transaction. Parity falls out of sharing the fold definitions.
2. **`seq` assignment** must be gap-free and serialized per `runId` (e.g. `SELECT ... FOR UPDATE` on a per-run counter, or `INSERT ... RETURNING` against a sequence keyed by run). The harness's `next_seq()` is the reference.
3. **Pointer NOTIFY** keeps payloads under Postgres's 8KB limit: `NOTIFY run_events, '{"runId":...,"seq":...}'`; the tail handler fetches the full `RunEventRecord` by `(runId, seq)`.
4. **Single NOTIFY channel** (`run_events`); the tail filters by `runId`/`threadId` and resumes from a `seq` offset on reconnect — matches the [Gateway SSE contract](../specs/03-platform.md#gateway).
5. **`init()` is safe to call from every service** (gateway + workflow service both boot it). The advisory lock serializes concurrent migration.
6. **Provider-placeholder exclusion** carries over: placeholders are not folded into `tool_calls` and never count as applied.

---

## Exit criteria / acceptance

- `RunStore.init()` creates the full schema on a clean database, is idempotent on re-run, and is safe under two concurrent boots (advisory lock).
- The Sprint 03 store-contract suite passes identically against memory and Postgres (parity).
- `events.append` is atomic: a failure rolls back the event + all projection updates together.
- `tail` delivers appended events to a LISTEN-ing client in < 100ms ([NFR](../specs/04-operations.md#non-functional-requirements)), and resumes from a `seq` offset after a simulated disconnect.
- `listRuns` keyset pagination via `before` returns stable pages.
- Event append latency < 5ms (append + projection update) under the NFR test.
- A run created in one process is fully reconstructable (messages, spans, status, cost) from Postgres in another process.

---

## Risks / open questions

- **Transaction scope vs latency:** folding many projections inside one transaction must stay under the 5ms append target. Batch projection upserts; index for the upsert keys.
- **`seq` contention** on high-fan-out runs (many parallel tool/agent events): the per-run serialization point could bottleneck. Measure; consider per-run advisory locks vs a sequence.
- **`LISTEN` connection management:** one dedicated client per gateway instance; handle reconnect + missed-NOTIFY gap by re-reading from last `seq`.
- **Which ops-table stores land now vs later:** recommend creating all tables here (migrations are cheap and ordering-sensitive) but implementing `SessionStore`/`ApprovalStore`/`OAuthStore` behavior in Sprints 17–19. These implementations live in `@render-agents/store` (the interfaces are store-owned per Sprint 01); the gateway sprints add only the routes that call them. Flag if the team prefers to defer table creation to those sprints (riskier for FK ordering).
