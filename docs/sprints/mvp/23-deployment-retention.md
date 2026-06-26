# Sprint 23 — Deployment, Configuration, Retention

**Status:** DRAFT
**Wave:** 4 — DX, Operability & Ship
**Depends on:** Wave 3 (the services to deploy)
**Unblocks:** —

---

## Goal

Define and validate the production deployment: the canonical `render.yaml` topology (gateway web service + workflow service + Postgres + optional cron), the environment-variable configuration contract, and the two-domain data-retention cleanup job — so a project runs in production with one config file and bounded storage growth.

---

## Foundational decisions in play

- Deployment model from [Operations → Deployment model](../specs/04-operations.md#deployment-model).
- Configuration homes from [Operations → Configuration](../specs/04-operations.md#configuration): no project-level config file; each concern has its own home.
- Retention domains from [Operations → Retention](../specs/04-operations.md#retention).

---

## Scope

**In:**
- **Canonical `render.yaml`** ([Operations → Deployment](../specs/04-operations.md#deployment-model)):
  - **Web service** — the gateway (Hono): webhook ingress, SSE, HITL, `/ui`.
  - **Workflow service** — workflow definitions + agent tasks (hosts the `agent@<plan>` task handlers + workflow root tasks).
  - **Postgres** — all durable state.
  - **Cron** (optional) — scheduled `POST /workflows/:name`.
  - **Private services** (optional) — MCP servers / custom tool backends.
- **Configuration contract (env vars)** — documented + wired end-to-end:
  - `DATABASE_URL` (Postgres vs in-memory), `RENDER_SDK_SOCKET_PATH`/`RENDER_USE_LOCAL_DEV` (dispatcher selection), `PORT`, provider API keys, and the SDK-owned (`RENDER_AGENTS_`-prefixed) settings `RENDER_AGENTS_API_KEY`, `RENDER_AGENTS_STRICT_APPROVAL`, `RENDER_AGENTS_ENCRYPTION_KEY` (OAuth token encryption), `RENDER_AGENTS_EVENT_RETENTION_DAYS`, `RENDER_AGENTS_RUN_RETENTION_DAYS`, retry/delegation overrides. (Naming convention per [Operations → Configuration](../specs/04-operations.md#configuration): SDK settings use `RENDER_AGENTS_`; platform/ecosystem names keep their standard form.)
- **Retention cleanup job** ([Operations → Retention](../specs/04-operations.md#retention)):
  - **Event-detail domain** (`run_events` + detail projections `spans`/`run_messages`/`tool_calls`/`workflow_steps`/`approval_requests`): default 30 days (`RENDER_AGENTS_EVENT_RETENTION_DAYS`), trimmed together.
  - **Run-summary domain** (`runs`): default 90 days (`RENDER_AGENTS_RUN_RETENTION_DAYS`).
  - Sessions/threads/schedules: no auto-expiry.
  - A daily background cleanup (or Render Cron trigger) that trims both domains in one pass.
- **Startup ordering / `init()`:** both services call `RunStore.init()` (advisory-locked migrations, Sprint 05); document boot order/health.

**Out:**
- The scaffolder embedding this manifest (Sprint 21 references it; here we own the canonical version — keep a single shared source).
- NFR perf validation + release/publish (Sprint 24).

---

## Deliverables

- Canonical `render.yaml` (services, Postgres, optional cron) — the version the scaffolder emits.
- Documented env-var configuration contract (and a `.env.example` shared with Sprint 21).
- Retention cleanup job (SQL + scheduler) honoring the two domains + `RENDER_AGENTS_EVENT_RETENTION_DAYS`/`RENDER_AGENTS_RUN_RETENTION_DAYS`.
- Deployment docs: deploy steps, health checks, scaling notes.

---

## Porting source

- **H — Deployment/blueprint patterns:** `render-agent-harness/.../web/src/routes/blueprint.ts`, `deployment.ts` — reference for `render.yaml` shape and Render service wiring; adapt to the 4-package SDK + the gateway/workflow split (drop the four runtime adapters and pg-boss — [§3](../specs/porting-map.md#3-not-ported-intentionally-dropped)).
- **H — Migrations:** `core/src/state/schema.ts` (advisory lock) — already ported in Sprint 05; here ensure both services boot it safely.

---

## Implementation notes

1. **One config file:** `render.yaml` is the deploy contract; agent config stays in markdown frontmatter, project metadata in `package.json`, secrets in env. No project-level config file ([Configuration](../specs/04-operations.md#configuration)).
2. **Two services, one runtime wiring:** gateway + workflow service both `createRuntime()` identically ([D5](../specs/00-foundations.md#d5--injectable-runtime--composition-root)); the workflow service additionally registers `agent@<plan>` + workflow root tasks (Sprints 11/12).
3. **Retention is two-domain:** keep `RENDER_AGENTS_RUN_RETENTION_DAYS > RENDER_AGENTS_EVENT_RETENTION_DAYS` (default 90 > 30) so operational history outlives high-volume detail; once event detail expires, full replay is no longer reconstructable for those runs (documented tradeoff). For strict replayability set them equal/`RUN <= EVENT`.
4. **Cleanup safety:** trim in a single daily pass; event-detail + detail-projection rows go together (projections are rebuildable only within the retained event horizon). Run via Render Cron or an internal daily job.
5. **Encryption key + secrets** (Sprint 19 OAuth) provisioned via Render env vars; never committed.

---

## Exit criteria / acceptance

- A `render.yaml`-defined deployment brings up gateway + workflow service + Postgres; both migrate via `init()` without conflict; health checks pass.
- An end-to-end production-shaped run works: trigger → workflow → `agent.task()` isolation → durable log → SSE → (optional) approval/resume.
- The configuration contract is documented and every listed env var is honored by the code.
- The retention job trims event-detail at `RENDER_AGENTS_EVENT_RETENTION_DAYS` and run-summaries at `RENDER_AGENTS_RUN_RETENTION_DAYS`; sessions/threads/schedules are untouched; a run older than the event horizon keeps its summary but loses detailed replay.
- The scaffolder's emitted `render.yaml` matches this canonical manifest.

---

## Risks / open questions

- **Render Workflows service shape:** confirm how the workflow service is declared in `render.yaml` and how it discovers/registers tasks at boot vs the web service (they share an image? separate?). This drives the two-service topology.
- **Cron auth + target:** the cron job needs the API key and the right `/workflows/:name`; document securely.
- **Retention vs in-flight runs:** ensure cleanup never trims events for active/paused runs regardless of age (guard on terminal status + age).
- **Single-source `render.yaml`:** keep one template shared by Sprint 21's scaffolder and this sprint to avoid drift.
