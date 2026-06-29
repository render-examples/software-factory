# MVP Follow-up — Implementation Audit & Gap Plan

**Status:** DRAFT
**Date:** 2026-06-29
**Branch:** `jacob/mvp-sprint-00`
**Scope:** Audit of `packages/*` against the layered spec (`docs/specs/00–06`, `porting-map.md`) and the MVP sprint plan (`docs/sprints/mvp`), plus a phased plan to close the gaps found.

---

## Executive summary

The implementation is **substantially complete and faithful** to the spec. All four runtime packages plus the scaffolder exist, the event-log-first architecture (D10) is implemented as specified, and every gateway route in the [Platform → Gateway](specs/03-platform.md#gateway) table is wired. The engine loop, HITL pause/resume-by-replay, subagent delegation with depth/fanout limits, OAuth refresh coalescing, two-domain retention, the Postgres parity suite, and the conventions-based loader are all present and test-backed (`pnpm --filter @render-agents/sdk test` → 50/50; engine suite green).

The remaining gaps are **not missing features** — they are concentrated in three areas:

1. **Spec/implementation drift** — the `interactive` agent field and the broadened `AgentRuntime`/`CreateRuntimeOptions` surface (both introduced by the recent threads work) ship in code but are undocumented in the normative spec.
2. **Observability completeness** — span projections omit several attributes the spec's observability table requires (agent version/model/iteration-count/final-usage on `agent` spans; `gen_ai.*` OTel naming on `llm` spans; explicit `latencyMs`/outcome on `tool` spans).
3. **Toolchain / workspace state** — the local tree fails the README build gate (`create-render-agent` deps not materialized) and the default `vitest` thread pool crashes under the installed Node 26.

Items the spec **intentionally defers post-MVP** (token-level `text.delta` streaming, the runtime `ScheduleStore` API, the full operator-UI SPA) are confirmed absent-by-design and are tracked below as future milestones, not regressions.

---

## Audit method

- Read the full normative spec: `00-foundations` (D1–D11), `01-authoring`, `02-execution`, `03-platform`, `04-operations`, `05-type-reference`, plus `porting-map.md`.
- Surveyed every source file in `packages/{sdk,engine,store,gateway,create-render-agent}/src`.
- Read the load-bearing implementations directly: `default-runner.ts`, `run-context.ts`, `context-manager-impl.ts`, `subagent-source.ts`, `projections.ts`, `retention.ts`, `gateway/app.ts`, `create-render-agent/blueprint.ts`, loader (`frontmatter.ts`/`validate.ts`/`load-agents.ts`), `runtime.ts`.
- Ran the build/test gates and inspected failures to separate code defects from environment state.

---

## Findings

| # | Severity | Area | Finding |
|---|---|---|---|
| F1 | **P1 — drift** | Authoring spec | `interactive` agent frontmatter field is implemented but undocumented in the spec. |
| F2 | **P1 — drift** | Type reference | `AgentRuntime` / `CreateRuntimeOptions` expose members not in the spec (`threadStore`, `oauthStore`, `oauthRefreshers`, `agentDefinitions`, `toolSources`, `extraRunners`). |
| F3 | **P2 — partial** | Observability | Span projections omit required span attributes; LLM spans don't use the `gen_ai.*` OTel namespace; no distinct `workflow`-kind span for in-process runs. |
| F4 | **P2 — toolchain** | Build/CI | `create-render-agent` fails `tsc` in this tree (deps not installed); default `vitest` pool crashes under Node 26. |
| F5 | **P3 — deferred** | Streaming | Token-level `text.delta` streaming (`ModelClient.stream`) is unimplemented — deferred per spec; SSE emits `message.assistant`. |
| F6 | **P3 — deferred** | Schedules | Runtime-managed `ScheduleStore` API/reconciliation is unimplemented — deferred per spec; MVP uses Render Cron → `/admin/retention` + `/workflows/:name`. |
| F7 | **P3 — deferred** | Operator UI | The full operator-UI SPA (L6) is deferred; `/ui` ships the read-only dev trace viewer only — matches the plan. |

---

## Detailed findings

### F1 — `interactive` agent field is undocumented (P1, spec drift)

The recent multi-turn-threads work (commit `21562dd`) added a first-class `interactive: boolean` agent flag:

- `packages/engine/src/agent.ts:71` — `interactive?: boolean` on `AgentDefinition`.
- `packages/sdk/src/loader/frontmatter.ts:8,40` — present in `KNOWN_FIELDS` and the Zod schema.
- `packages/sdk/src/loader/load-agents.ts:151` — threaded into the resolved definition.
- `packages/engine/src/default-runner.ts:149,158` — drives the `awaitInput()` park behavior.
- `packages/create-render-agent/src/blueprint.ts:224` — emitted in the scaffolded `assistant.md`.

But the spec does not mention it:

- `docs/specs/01-authoring.md` frontmatter field table (lines ~99–118) has no `interactive` row.
- `docs/specs/05-type-reference.md` `AgentDefinition` (lines ~19–41) omits the field.
- The fail-fast validation list (`01-authoring.md` "Validation") doesn't cover it.

**Impact:** the normative contract is now behind the code; an author reading the spec wouldn't know interactive threads exist, and a future spec-faithful reimplementation would reject the field as "unknown frontmatter."

### F2 — `AgentRuntime` / `CreateRuntimeOptions` surface drift (P1, spec drift)

The spec's [`AgentRuntime`](specs/05-type-reference.md#agentruntime) is `{ store, tracer, model, runners, hooks, contextManager, dispatcher? }`, and `CreateRuntimeOptions` lists a fixed override set. The implementation (`packages/sdk/src/runtime.ts`) adds public members not in the type reference:

- `runtime.ts:54,56` — `threadStore`, `oauthStore` (the spec places these *inside* `store`; `ToolContext.connection` and the gateway resolve them there).
- `runtime.ts:68,72` — `agentDefinitions: Map<…>`, `toolSources: Map<…>`.
- `oauthRefreshers` (used by `gateway/app.ts:125`).
- `runtime.ts:83,90` — `CreateRuntimeOptions.extraRunners`, `toolSources`.

These are reasonable composition-root conveniences, but they're undocumented, so the spec's type reference no longer matches the shipped surface.

**Impact:** consumers wiring a custom gateway/worker against the spec will find the real runtime has a different shape than documented.

### F3 — Observability span attributes incomplete (P2, partial)

[Platform → Observability](specs/03-platform.md#observability) specifies required attributes per span kind and that "attributes follow OTel semantic conventions where applicable (`gen_ai.*` namespace for LLM spans)." The span fold (`packages/store/src/projections.ts:216–256`) diverges:

- **`agent` spans** (`run.started` → `open("agent", …)`, line 218) carry **no attributes** — the spec requires agent name, **agent version**, model, **final token usage**, and **iteration count**. (`agentVersion` is folded onto the `RunRecord` at `projections.ts:102`, but not onto the agent span.)
- **`llm` spans** (line 253) carry `{ usage, costUsd, stopReason, latencyMs }` but **not** under the `gen_ai.*` namespace; `grep gen_ai` across `packages/*/src` returns nothing.
- **`tool` spans** record outcome via `status` but expose no explicit `latencyMs` attribute (spec lists "latency ms").
- **`workflow`-kind span**: in-process runs open an `agent` span at the root; there's no distinct `workflow` span for the run as the spec's trace tree depicts. (The `SpanKind` union includes `"workflow"`, so the kind exists but isn't emitted on this path.)

**Impact:** the trace tree is structurally correct and cost attribution works, but per-span detail and OTel-export fidelity fall short of the spec. This is "where applicable," so it's a completeness gap rather than a correctness bug.

### F4 — Build/test gates don't pass clean in this tree (P2, toolchain)

`pnpm build && pnpm typecheck && pnpm lint && pnpm test` (README dev gate) does not pass as-is here:

- **`create-render-agent` build fails** — `tsc` errors with `TS2307` (`node:path`, `node:fs/promises`, `@clack/prompts`) and `TS2580` (`process`). Root cause is **workspace install state, not source**: `packages/create-render-agent/node_modules` contains only `typescript` + `vitest`; `@clack/prompts` is in `pnpm-lock.yaml` (lines 41, 225) but was never materialized into the pnpm store (`node_modules/.pnpm/@clack*` is absent). The fix is a clean `pnpm install`; but until then the build gate and any publish are blocked, and there's no CI assertion catching the "deps not materialized" state.
- **Default `vitest` pool crashes under Node 26** — the threads pool worker exits unexpectedly ("Worker exited unexpectedly", Node v26.0.0) during `@render-agents/sdk:test`. Running the same suite with `--pool=forks` passes 50/50. The spec NFR pins **Node 20+**; the local runtime is Node 26 and the installed `@types/node` resolved to `26.0.1` (not the declared `^22`). The harness isn't resilient to / pinned against the running Node.

**Impact:** a contributor following the README can't get a green gate without reinstalling and/or switching Node; CI green depends on the (presumably Node-20) CI image, masking the local-tree fragility.

### F5–F7 — Confirmed post-MVP deferrals (P3, tracked)

These match the spec/plan and are listed so they're tracked, not lost:

- **F5 — `text.delta` token streaming.** `ModelClient.stream` is optional and unimplemented; SSE delivers `message.assistant` events. [Platform → SSE](specs/03-platform.md#gateway) explicitly marks token-level streaming post-MVP.
- **F6 — Runtime schedules.** `ScheduleStore` + the `schedules` table exist as the future contract (`packages/store/src/schedule-store.ts`); no reconciliation loop or `/schedules` API. [Platform → Schedules](specs/03-platform.md#schedules) specifies Render Cron for MVP — and the scaffolder's `render.yaml` wires a daily retention cron, matching this.
- **F7 — Operator UI SPA.** Deferred per the [porting map](specs/porting-map.md#3-not-ported-intentionally-dropped); `/ui` is the read-only dev trace viewer (sprint 22), as the MVP plan states.

---

## Remediation plan

Three short phases. P1/P2 close the real drift and harden the gate; P3 is the post-MVP backlog, scoped but not scheduled here.

### Phase 1 — Reconcile spec with shipped code (P1) — docs only, no code risk

Goal: the normative spec describes exactly what ships.

1. **Document `interactive`** (F1):
   - Add an `interactive` row to the `docs/specs/01-authoring.md` frontmatter table (`boolean`, default `false`, "parks on `awaitInput()` after a terminal turn — the basis for interactive threads"), with a one-line cross-reference to [Execution → HITL/awaiting input](specs/02-execution.md#hitl-pause--resume).
   - Add `interactive?: boolean` to `AgentDefinition` in `docs/specs/05-type-reference.md` with the same doc comment as `agent.ts:65–71`.
   - Note in the validation list that `interactive` is a known boolean field.
2. **Document the runtime surface** (F2):
   - Update `AgentRuntime` and `CreateRuntimeOptions` in `docs/specs/05-type-reference.md` to include `threadStore`, `oauthStore`, `oauthRefreshers`, `agentDefinitions`, `toolSources`, and the `extraRunners`/`toolSources` options — or, if the intent is to keep `AgentRuntime` minimal, refactor `runtime.ts` to nest the operational stores under `store` (per `05-type-reference.md` "operational persistence interfaces are physically defined in `@render-agents/store`"). **Recommended:** document the broadened surface (lower risk than re-plumbing the gateway).
3. **Acceptance:** a spec reader can author an `interactive` agent and wire a custom runtime without reading source; `05-type-reference` matches `runtime.ts` field-for-field.

### Phase 2 — Observability + gate hardening (P2) — small, test-backed code changes

1. **Enrich span attributes** (F3) in `packages/store/src/projections.ts`:
   - On `agent` spans, attach `{ agentName, agentVersion, model, iterationCount, usage }` (iteration count = number of `llm.call` events folded for the run; usage = summed `llm.call` usage; model from the first `llm.call`).
   - On `llm` spans, add `gen_ai.*` aliases (`gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.response.finish_reasons`) alongside the existing keys.
   - On `tool` spans, add `latencyMs` (close-ts minus start-ts) and an explicit `ok`/`error` attribute.
   - Decide and document whether the run root is an `agent` or `workflow` span; if the trace-tree depiction is normative, open a `workflow`-kind root span for workflow-dispatched runs.
   - Extend `pg/parity.test.ts` + a memory-store test to assert the new attributes survive replay byte-for-byte.
2. **Harden the build/test gate** (F4):
   - Add `engines.node` / an `.nvmrc` (or `packageManager` + a CI matrix) pinning the supported Node, and set vitest `pool: "forks"` in `vitest.config.ts` so the suite is resilient to the Node-26 threads-pool crash. Align `@types/node` with the supported major.
   - Add a CI step (or `preinstall`/`postinstall` check) that fails loudly when a workspace package's declared deps aren't materialized, so the `create-render-agent` "deps missing" state can't pass silently.
   - Re-run `pnpm install && pnpm build && pnpm typecheck && pnpm lint && pnpm test && pnpm check:bundle-size` to a clean green and record it in the PR.
3. **Acceptance:** observability attributes match the spec table (asserted in tests); the full README gate passes locally on the pinned Node.

### Phase 3 — Post-MVP backlog (P3) — scoped, not scheduled

Track as future sprints; each already has a spec contract to build against:

- **Token-level streaming** (F5): implement `ModelClient.stream` for Anthropic/OpenAI, lift `ModelStreamEvent` → `text.delta` in the runner, and surface over SSE. Spec: [`ModelStreamEvent`](specs/05-type-reference.md#modelstreamevent), [SSE events](specs/03-platform.md#gateway).
- **Runtime schedules** (F6): implement `ScheduleStore` against the existing `schedules` table + a reconciliation trigger, behind the documented MVP Render-Cron path.
- **Operator UI SPA** (F7): the full L6 UI ([`06-operator-ui.md`](specs/06-operator-ui.md)) over the existing read-only routes.

---

## What was verified working (no action needed)

For confidence, these spec areas were checked and found correct:

- **Event-log-first (D10):** single `events.append` write path; `runs`/`spans`/`messages`/`tool_calls`/`workflow_steps`/`approval_requests` are folds (`projections.ts`); Postgres parity suite present (`store/src/pg/parity.test.ts`).
- **Loop & dispatch (D2/D9):** iterate→model→tool sequence with idempotency short-circuit, approval gate, input validation, error containment (`default-runner.ts:177–234`).
- **HITL (D7):** `requestApproval` state machine, auto/strict modes + `approval.auto` audit event, `awaitInput()` + resume-by-replay (`run-context.ts:283–353`).
- **Context management (D11):** auto-compaction with safe assistant-boundary snapping, superseded-tool-output trimming, `context.compacted` emission (`context-manager-impl.ts`).
- **Subagents:** `subagents__<name>` tools, `maxDepth`/`maxFanout` enforcement returning error `tool_result`, `RunPaused` propagation (`subagent-source.ts`).
- **Budgets/cost:** per-invocation ceilings, unpriced-model warning, `maxCostUsd: null/0` opt-out (`default-runner.ts:329–338`, model pricing warning observed at test time).
- **Gateway:** all 20 routes from the spec table mounted; `409 thread_busy` and `SELECT … FOR UPDATE` refresh-coalescing edge cases test-backed.
- **Scaffolder:** generates the full convention layout + `render.yaml` (web + worker + retention cron) + `_shared.md` merge + interactive `assistant` agent (`blueprint.ts`).
- **Retention/config:** two-domain cleanup with env-driven horizons (`retention.ts`); `RENDER_AGENTS_*` config surface present.
