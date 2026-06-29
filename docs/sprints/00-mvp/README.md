# render-agents — MVP Sprint Plan

**Status:** ✅ COMPLETE — all sprints (00–24) implemented across Waves 0–4.
**Date:** 2026-06-26

This directory decomposes the [render-agents specification](../specs/00-foundations.md) into an ordered set of MVP sprints, built **sequentially** in the numbered order. Each sprint is a self-contained build spec; this file is the index that groups them into waves and records the per-wave exit criteria. (Each sprint doc lists its own depends-on/unblocks for context; because the build is sequential, the index does not re-track them.)

Read the [Foundations](../specs/00-foundations.md) (especially decisions D1–D11) and the [Porting Map](../specs/porting-map.md) before starting any sprint.

---

## Sequencing philosophy

Three principles drive the ordering:

1. **Event-log-first (the keystone).** [D10](../specs/00-foundations.md#d10--the-append-only-event-log-is-the-single-source-of-truth) makes the append-only `run_events` log the single source of truth — messages, spans, idempotency, step memoization, approvals, cost, run status, and SSE are all *projections* of it. Almost everything depends on the log, so it lands in Wave 0 and every later feature is expressed as "emit an event / fold a projection," never a bespoke store.
2. **Walking skeleton, then vertical slices.** Wave 0 proves the spine end-to-end (markdown agent → runtime → event-sourced loop → mock model → read back) entirely in-memory. After that, each wave is a vertical slice that leaves the system runnable and demoable — not a horizontal layer that is dead until the next one lands.
3. **Parity as a forcing function.** Because `run` vs `task` is just a call site ([D2](../specs/00-foundations.md#d2--one-execution-model-run-vs-task-is-a-method-call-not-config)) and local == production ([D8](../specs/00-foundations.md#d8--observable-by-default-every-unit-is-a-span-postgres-is-source-of-truth)), the in-memory runtime + `mockModel` built in Wave 0 becomes the test substrate for *every* subsequent sprint. Each sprint ships test-backed against the real loop.

---

## Waves at a glance

| Wave | Theme | Sprints | Exit state |
|---|---|---|---|
| **0** | Foundations & Skeleton | 00–04 | A markdown agent runs in-process against a mock model, fully event-sourced and tested, in-memory only. |
| **1** | Core Execution Engine | 05–10 | One agent runs durable, observable, budgeted, with real models, tools, skills, structured output, and managed context. |
| **2** | Orchestration & Durability | 11–15 | Durable multi-agent pipelines with task isolation, HITL pause/resume, subagents, and hooks. |
| **3** | Platform & Serving | 16–20 | A deployable gateway: triggerable, streamable, multi-tenant (threads, approvals, OAuth, webhooks). |
| **4** | DX, Operability & Ship | 21–24 | Scaffoldable, observable (dev trace viewer), deployable, hardened, and publishable. |

---

## Wave 0 — Foundations & Walking Skeleton

> Goal: stand up the monorepo and prove the event-sourced loop runs a markdown agent in-process against a mock model — fully in-memory and tested. De-risks [D1](../specs/00-foundations.md#d1--markdown-is-the-agent), [D5](../specs/00-foundations.md#d5--injectable-runtime--composition-root), and [D10](../specs/00-foundations.md#d10--the-append-only-event-log-is-the-single-source-of-truth) immediately.

| # | Sprint |
|---|---|
| [00](00-scaffolding.md) | Scaffolding & monorepo |
| [01](01-type-contracts.md) | Public type contracts + testing utilities |
| [02](02-authoring-discovery.md) | Authoring & discovery (markdown → `AgentSet`) |
| [03](03-event-log-memory-store.md) | Event log + in-memory store + projection fold |
| [04](04-runtime-loop-skeleton.md) | Runtime composition + default loop skeleton |

**Wave exit:** `loadAgents().get("x").run(input)` works in-memory, fully event-sourced, with passing tests over the real loop using `mockModel`.

---

## Wave 1 — Core Execution Engine

> Goal: a single agent runs fully-featured and production-grade — Postgres-backed, against real models, with tools, budgets, skills, structured output, managed context, and full tracing.

| # | Sprint |
|---|---|
| [05](05-postgres-store.md) | Postgres store + migrations + projections + `NOTIFY` |
| [06](06-model-clients-cost.md) | Model clients, tiers, cost estimation, retry |
| [07](07-tools-dispatch.md) | Tool system + environment + dispatch sequence + SSRF fetch |
| [08](08-loop-features.md) | Loop features: budgets, structured output, skill loading |
| [09](09-context-management.md) | Context management & compaction (D11) |
| [10](10-tracing-observability.md) | Tracing & observability (span projections, cost attribution) |

**Wave exit:** one agent runs durable, observable, budgeted, with tools/skills/structured output against real Anthropic/OpenAI models, persisting to Postgres.

---

## Wave 2 — Orchestration & Durability

> Goal: durable multi-agent pipelines with isolation, human-in-the-loop, and extension points.

| # | Sprint |
|---|---|
| [11](11-workflows-dispatch.md) | Render Workflows dispatch (`agent.task()`, plan-tier tasks, dispatch keys, fallback) |
| [12](12-workflows-determinism.md) | Workflows + determinism (`workflow()`, `WorkflowContext`, `ctx.step`) |
| [13](13-hitl-idempotency-cancellation.md) | HITL pause & resume + idempotency + cancellation |
| [14](14-subagents.md) | Subagent delegation |
| [15](15-hooks.md) | Hooks (event-stream middleware) |

**Wave exit:** a multi-agent workflow fans out via `agent.task()`, pauses for approval, and resumes by replay — all observable in the trace.

---

## Wave 3 — Platform & Serving (gateway)

> Goal: a deployable web service that is externally triggerable, streamable, and multi-tenant.

| # | Sprint |
|---|---|
| [16](16-gateway-core.md) | Gateway core (Hono, runs/spans/tool-calls routes, API-key auth) |
| [17](17-streaming-sessions.md) | SSE streaming (live tail of log) + threads |
| [18](18-gateway-hitl.md) | Gateway HITL (approvals API + resume endpoint) |
| [19](19-oauth-multitenancy.md) | OAuth & multi-tenancy |
| [20](20-webhooks-connectors-schedules.md) | Webhooks, connectors, schedules (Render Cron) |

**Wave exit:** the system deploys as gateway + workflow service + Postgres, accepts webhook/HTTP/cron triggers, streams runs over SSE, and resolves approvals out-of-band.

---

## Wave 4 — DX, Operability & Ship

> Goal: scaffold, observe, deploy, and harden for release.

| # | Sprint |
|---|---|
| [21](complete/21-scaffolder.md) | Scaffolder (`create-render-agents`) + default example project |
| [22](complete/22-dev-trace-viewer.md) | Dev-mode trace viewer (`/ui`) |
| [23](complete/23-deployment-retention.md) | Deployment (`render.yaml`), configuration, retention cleanup |
| [24](complete/24-hardening-release.md) | NFR hardening, docs, release/publish |

**Status:** ✅ Complete — all Wave 4 sprints implemented.

**Wave exit:** `npm create render-agents` scaffolds a working project that deploys to Render with one `render.yaml`; packages publish to npm; NFR targets are met.

> The full operator-UI SPA described in [L6](../specs/06-operator-ui.md) is **deferred post-MVP** (per the [Porting Map](../specs/porting-map.md#3-not-ported-intentionally-dropped)). Sprint 22 ships the template's existing trace viewer as a read-only dev-mode stopgap.

---

## Sprint document template

Every numbered sprint doc follows this shape:

1. **Goal** — one sentence.
2. **Wave / depends-on / unblocks.**
3. **Foundational decisions in play** — links to the relevant D1–D11.
4. **Scope** — in / out.
5. **Deliverables** — packages touched, public surface added, files.
6. **Porting source** — the `H`/`T` lift-and-shift rows from the [Porting Map](../specs/porting-map.md) relevant to this sprint.
7. **Implementation notes** — sequencing within the sprint, key contracts.
8. **Exit criteria / acceptance** — what is demoable + test expectations (real loop vs `mockModel`).
9. **Risks / open questions.**
