# Sprint 08 — Loop Features: Budgets, Structured Output, Skill Loading

**Status:** DRAFT
**Wave:** 1 — Core Execution Engine
**Depends on:** 06 (model clients + cost), 07 (tool dispatch + `load_skill` plumbing)
**Unblocks:** —

---

## Goal

Fill in the loop's per-invocation safety and capability features that were stubbed in Sprint 04: budget enforcement (iterations/tokens/cost/wall-clock), structured output (schema-constrained final turn + validate/retry), and skill loading (catalog in the prompt + `load_skill` returning skill content via progressive disclosure).

---

## Foundational decisions in play

- Budgets from [Execution → Budgets & cost](../specs/02-execution.md#budgets--cost).
- Structured output from [Execution → Structured output](../specs/02-execution.md#structured-output).
- Skill loading / progressive disclosure from [Execution → Skill loading](../specs/02-execution.md#skill-loading) and [Authoring → Skills](../specs/01-authoring.md#skills).

---

## Scope

**In:**
- **Budget enforcement** (per agent invocation, checked at the top of each iteration before the LLM call):
  - `maxIterations` (default 50) → "maxIterations reached" error.
  - `maxTokens` (default 1,000,000) → "token budget exhausted" error.
  - `maxCostUsd` (default 10; `null`/`0` disables) → "cost budget exhausted" error.
  - `maxWallSeconds` (no default) → `AbortSignal` via `setTimeout`.
  - Cost accumulation: `estimateCost` after each `complete()`, accumulated against the invocation total *and* folded into `runs.totalCostUsd` (the `llm.call` event carries `costUsd`; the fold is from Sprint 03).
  - Unpriced-model behavior: cost budget not enforced, other budgets still apply; the `maxCostUsd: null/0` opt-out silences the warning.
- **Structured output:**
  - The final turn is **detected, not predicted**: when the model signals `end_turn` with no outstanding `tool_use`, the runner performs the structured step rather than returning raw text. For agents with an `output` schema it sets `CompleteArgs.responseFormat = { type: "json_schema", schema }` on that schema-constrained completion (and skips the extra round-trip when the natural final turn was already produced under `responseFormat`).
  - Provider-native enforcement where available; system-prompt JSON-instruction fallback otherwise (capability matrix from Sprint 06).
  - Parse + validate the result against the schema; populate `AgentOutput.data` (and `text` = raw JSON). On validation failure, retry a small bounded number of times feeding the error back; then error.
  - Agents without `output`: `data` undefined, text only (unchanged).
- **Skill loading (progressive disclosure):**
  - During prompt assembly, append a compact **catalog** entry per declared skill (`id`, `name`, `description`, `whenToUse`) — not the body. No skills → no catalog, no tool.
  - Auto-mount the built-in `load_skill` tool (plumbed in Sprint 07) when the agent declares ≥1 skill; its `invoke` returns the resolved skill's `content` as the `tool_result`.
  - Constrained to declared skill ids; unknown/undeclared id → error `tool_result` (no crash). Idempotent (same skill twice short-circuits via the tool-call idempotency from Sprint 07/03).

**Out:**
- Context compaction (Sprint 09) — budgets bound cost; compaction (quality) is separate.
- The `load_skill` tool *plumbing* (done in Sprint 07) — here we implement its `invoke` body + the catalog.
- HITL/cancellation interplay (Sprint 13) — budget checks sit alongside cancel checks in the iterate preamble; cancel store lands later.

---

## Deliverables

`@render-factory/engine`:
- Budget checker in the iterate preamble (+ `maxWallSeconds` abort wiring).
- Cost accumulation + `llm.call` event emission carrying `usage`/`costUsd`/`stopReason`/`latencyMs`.
- Structured-output path: `responseFormat` request, parse/validate, bounded retry, `AgentOutput.data` population.
- Skill catalog assembly + `load_skill` invoke body.

---

## Porting source

- **H — Budget enforcement:** `render-agent-harness/.../core/src/loop.ts` (`overBudget`, `estimateCost`, `addUsage`) — port; adapt `DEFAULT_BUDGET` to the spec defaults (`maxIterations: 50`, `maxTokens: 1_000_000`, `maxCostUsd: 10`; harness had `maxWallSeconds: 39600`).
- **T — Skill system:** `agent-workflows-template/src/engine/skills.ts` + `load_skill` tool — direct lift for the catalog + on-demand load; resolution is constrained to the agent's declared skills.
- **T — Loop:** `agent-workflows-template/src/engine/loop.ts` — extend the existing iterate preamble (it already checks `maxIterations`/`maxTokens`) with cost + wall-clock; the loop now emits `llm.call` rather than accumulating usage locally.

---

## Implementation notes

1. **Budget checks live in the iterate preamble** (loop steps 1–3), before the model call, so a runaway loop is bounded *before* spending. `maxWallSeconds` arms a `setTimeout` that aborts the shared signal.
2. **Cost is folded, not stored twice:** the loop emits `llm.call { usage, costUsd }`; the `runs.totalCostUsd` and agent-span cost are projections (Sprint 03/10). The invocation-local accumulator is only for budget enforcement.
3. **Structured output triggers at the `end_turn` boundary:** the runner can't know the final turn ahead of time, so it acts when the model stops requesting tools (`end_turn`, no pending `tool_use`) and issues the schema-constrained completion then. On parse/validate failure, append the validation error as a user/tool message and retry within the bounded count (these retries *do* consume iterations/tokens — they are real turns).
4. **Skill catalog is part of prompt assembly** (alongside agent body + `_shared.md`); keep it compact to preserve the progressive-disclosure token savings. `load_skill` returns content as an ordinary `tool_result`, inheriting dispatch/idempotency/tracing for free.

---

## Exit criteria / acceptance

- Each budget trips with the correct error/behavior: iteration cap, token cap, cost cap, and wall-clock abort; `maxCostUsd: null/0` disables the cost ceiling (and silences the unpriced warning).
- An unpriced model still respects `maxIterations`/`maxTokens`/`maxWallSeconds`.
- An agent with an `output` schema yields validated `AgentOutput.data`; an intentionally-malformed first response triggers the bounded validate/retry then succeeds; exceeding retries errors clearly. Agents without `output` are unchanged.
- A skill-declaring agent shows the catalog (not bodies) in its system prompt; the model calls `load_skill({id})` and receives the content; an undeclared id returns an error result; loading the same skill twice short-circuits.
- `llm.call` events carry correct `usage`/`costUsd`; `runs.totalCostUsd` matches the sum.

---

## Risks / open questions

- **Cost budget on the last turn:** a single final turn can overshoot `maxCostUsd` (the harness's "budget overflow on the last turn" edge case — [Porting principle 5](../specs/porting-map.md#4-porting-principles)). Decide: enforce pre-call estimate vs allow the in-flight turn to complete then trip. Recommend pre-call check + post-call accounting, matching the harness.
- **Structured-output retries vs budget:** validate/retry turns consume budget; ensure they're counted and can themselves trip a budget (and that the error is clear about which limit was hit).
- **Provider fallback fidelity:** the system-prompt JSON fallback is less reliable than native; ensure validation+retry compensates and the capability matrix is accurate.
