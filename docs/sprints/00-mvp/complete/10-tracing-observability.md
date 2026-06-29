# Sprint 10 — Tracing & Observability

**Status:** DRAFT
**Wave:** 1 — Core Execution Engine
**Depends on:** 03 (span projection), 04 (loop emits span events)
**Unblocks:** 16 (gateway span routes), 22 (dev trace viewer)

---

## Goal

Complete the observability model: every execution unit (workflow run, step, agent, LLM call, tool call) is a span folded from span-producing events, with the required attributes and cost attribution, an optional OTel exporter, and the `Tracer` realized as an event emitter — so "what happened and what did it cost" works against Postgres with zero external setup.

---

## Foundational decisions in play

- [D8](../specs/00-foundations.md#d8--observable-by-default-every-unit-is-a-span-postgres-is-source-of-truth) — observable by default; every unit is a span; Postgres is the source of truth; OTel export optional.
- [D10](../specs/00-foundations.md#d10--the-append-only-event-log-is-the-single-source-of-truth) — the trace tree is a projection of the event log, not a parallel instrumentation path.

---

## Scope

**In:**
- **`Tracer` as event emitter:** `onStart`/`onEnd` emit span-producing events (carrying `spanId`/`parentSpanId`/`kind`) into the log rather than writing a `spans` store directly. The `spans` projection (Sprint 03) folds them.
- **Span kinds + hierarchy** per [Platform → Observability](../specs/03-platform.md#observability): `workflow` → `step`/`agent` → `llm` → `tool`, including subagent nesting (`subagents__<name>` tool span → child `agent` span — fully realized in Sprint 14; the tree shape is established here). Note the child `agent` span lives in the **child run** (its own `runId`); the cross-run delegation tree is stitched via `subagent.spawned.childRunId` at the read layer, not returned by a single `listSpans(runId)`.
- **Required attributes per span kind** (the [span attributes table](../specs/03-platform.md#observability)): workflow (name, trigger, input summary); step (name); agent (name, **version**, model, final token usage, iteration count); llm (model, input/output tokens, stop reason, latency); tool (name, latency, success/error). `load_skill` appears as an ordinary `tool` span with the loaded skill `id` in attributes.
- **OTel semantic conventions** where applicable (`gen_ai.*` for LLM spans).
- **Cost attribution:** each LLM span carries `inputTokens`/`outputTokens`; cost computed from pricing accumulates into the agent span. **Within a single run**, the sum of its agent spans equals that run's `runs.totalCostUsd` (both fold the same `llm.call` events). The **all-in cost of a delegating run** (root + isolated `agent.task()`/subagent children) is a **read-layer aggregate** that sums each child run's `totalCostUsd`, discovered by walking `subagent.spawned.childRunId` — *not* a single per-run fold (child runs own their own `runId`).
- **Optional OTel exporter:** export spans to external collectors (Datadog/Honeycomb/Grafana) behind an opt-in; **not required** for full visibility.
- **`agentVersion`** recorded on agent spans + `RunRecord` for audit/repro.

**Out:**
- The gateway HTTP routes that serve spans/tool-calls (Sprint 16) — this sprint ensures the projection + attributes are complete and correct.
- The dev trace viewer UI (Sprint 22).
- `text.delta` token streaming spans (post-MVP).

---

## Deliverables

`@render-agents/store` (+ engine wiring):
- `Tracer` implementation emitting span events through `RunContext.emit`.
- Span-attribute population for all five kinds at start/end.
- Cost rollup into agent spans + run total (verify against the `runs`/`spans` projections).
- Optional OTel exporter module (opt-in via env), mapping span records → OTLP.

---

## Porting source

- **T — Tracing:** `agent-workflows-template/src/engine/store/tracer.ts`, `types/trace.ts` — spans become a **projection** of span-producing events; the tracer emits those events rather than writing a separate spans store. Keep the `workflow`/`step` span kinds and the start/end shape.
- The template loop (`loop.ts`) already opens `llm`/`tool` spans per turn — adapt that to emit events through `ctx`/tracer instead of calling a tracer sink directly.

---

## Implementation notes

1. **No parallel instrumentation path:** the tracer is just another event emitter. Anything observable in a trace is therefore also in the log and on the SSE stream — one taxonomy.
2. **Span start/end pairing:** `*.started` opens, `*.completed` closes; the projection assembles `started_at`/`finished_at`/`status`/`output`/`error`. Ensure every opened span is closed on success, error, and abort/cancel paths.
3. **Attribute completeness is testable:** assert each span kind carries its required attributes (the [table](../specs/03-platform.md#observability)).
4. **Cost consistency:** the agent-span cost rollup and `runs.totalCostUsd` must agree (both fold `llm.call`). Add a cross-check test.
5. **OTel is export-only:** Postgres remains source of truth; the exporter reads the span projection (or tees off emitted events) and ships OTLP — failures in export never affect the run.

---

## Exit criteria / acceptance

- A multi-turn agent run with tool calls yields a correct span tree (workflow/agent/llm/tool nesting) via `listSpans`, with all required attributes per kind.
- For a single run, agent-span cost rollup equals that run's `totalCostUsd`; both equal the sum of its `llm.call` costs. For a delegating run, the read-layer aggregate (root + child runs, via `subagent.spawned.childRunId`) equals the sum of every run's `llm.call` costs across the tree.
- Spans close correctly on success, tool error, model error, and cancellation (no perpetually-"running" spans).
- `agentVersion` appears on agent spans and the run record.
- With the OTel exporter enabled, spans are emitted as OTLP to a test collector; with it disabled, full visibility still works from Postgres alone.

---

## Risks / open questions

- **Span-event volume:** every turn/tool adds start+end events; ensure the append/fold cost stays within the 5ms NFR and that high-fan-out runs don't bloat the log unduly (retention in Sprint 23 mitigates).
- **`gen_ai.*` convention drift:** OTel GenAI semconv is evolving; pin a version and document mappings.
- **Subagent tree depth:** the nesting contract is set here but exercised in Sprint 14; keep `parentSpanId` propagation correct across dispatch boundaries (Sprint 11) so the tree doesn't break across task containers.
