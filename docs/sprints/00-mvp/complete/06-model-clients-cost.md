# Sprint 06 — Model Clients, Tiers, Cost Estimation, Retry

**Status:** DRAFT
**Wave:** 1 — Core Execution Engine
**Depends on:** 04 (loop calls `ModelClient`)
**Unblocks:** 08 (budgets/cost + structured output use real providers), 09 (compaction summarizes via a real `ModelClient`)

---

## Goal

Implement the provider-agnostic `ModelClient` with concrete Anthropic and OpenAI clients, the tier→model resolution, transparent transient-failure retries, and the cost model (`MODEL_PRICING` + `estimateCost`) — so the loop runs against real models with real token/cost accounting.

---

## Foundational decisions in play

- [D5](../specs/00-foundations.md#d5--injectable-runtime--composition-root) — the model client is a runtime dependency, provider inferred from the agent's `model`/`apiKeyEnv`.
- Model resolution & validation split from [Authoring → Agent Markdown Schema](../specs/01-authoring.md#agent-markdown-schema) (routing/tier hard errors; pricing a warning).

---

## Scope

**In:**
- **`ModelClient` interface** realization with `complete(args)` for Anthropic and OpenAI; provider selection from `ModelSpec.provider` (explicit) or inference from `model` id, with `baseURL`/`apiKeyEnv` overrides.
- **Wire-format adapters** mapping the SDK's provider-agnostic [`Message`](../specs/05-type-reference.md#message)/[`ContentBlock`](../specs/05-type-reference.md#contentblock)/[`ToolSchema`](../specs/05-type-reference.md#toolschema)/[`CompleteArgs`](../specs/05-type-reference.md#completeargs) ↔ each provider's request/response shape, returning a normalized [`CompleteResult`](../specs/05-type-reference.md#completeresult) (`content`, `usage`, `stopReason`).
- **`responseFormat` support** in `CompleteArgs` plumbed to provider-native structured output where available (OpenAI `response_format`, Anthropic JSON/tool mode); the fallback (system-prompt JSON instruction) is consumed by Sprint 08.
- **Model tiers:** Sprint 02 already lands the data-only `small`/`medium`/`large` tier table + `resolveModelSpec` (an `engine` module the loader imports for load-time validation). This sprint **layers provider inference + pricing on that same table** — it does not redefine it; raw model strings pass through with provider inference.
- **`RetryPolicy`:** exponential backoff + jitter, honoring `Retry-After`, on network errors + `retryableStatuses` (default `[429,500,502,503,504]`). Retries are **transparent**: not new loop iterations, no added token budget; `maxWallSeconds` still bounds elapsed time. Configurable via `createRuntime({ retry })` + env.
- **Cost model:** `MODEL_PRICING` (per-1M in/out) for known models + `estimateCost(model, usage)`; routable-but-unpriced → `0` with a **loud load-time + runtime warning**; custom pricing merged via `createRuntime({ pricing })`.
- **`ModelClient.stream?`** signature present but optional/unimplemented (token-level deltas are post-MVP; the loop falls back to `complete()`).

**Out:**
- Budget *enforcement* and folding cost into `llm.call`/`runs.totalCostUsd` (Sprint 08 + already-folded projection from Sprint 03) — this sprint provides `estimateCost`; the loop emits the `llm.call` event carrying `costUsd`.
- Structured-output *validation/retry-on-invalid* loop (Sprint 08).
- Token-level streaming + `text.delta` (post-MVP).

---

## Deliverables

`@render-factory/engine`:
- `ModelClient` + `AnthropicClient` + `OpenAIClient` with request/response adapters.
- Provider inference + pricing layered over Sprint 02's `model-tiers` table (no second copy).
- `RetryPolicy` + retrying wrapper around `complete`.
- `MODEL_PRICING` + `estimateCost`.
- Unpriced-model warning emitter (load-time + runtime).

---

## Porting source

- **T — Model client + tiers:** `agent-workflows-template/src/engine/model.ts`, `model-tiers.ts` — direct lift; update the tier table to the spec's models (`claude-haiku-4-5`/`claude-sonnet-4-6`/`claude-opus-4-6`); add `estimateCost` + `MODEL_PRICING`.
- **H — Budget/cost estimation:** `render-agent-harness/.../core/src/loop.ts` (`estimateCost`, `addUsage`) — port the cost estimation approach and default pricing handling; adapt `DEFAULT_BUDGET` numbers in Sprint 08.

---

## Implementation notes

1. **One retrying wrapper** around both clients (provider-agnostic): classify retryable vs fatal, back off with jitter, honor `Retry-After`. Surface the *final* failure to the loop; retries never emit loop events.
2. **Usage normalization:** map each provider's token accounting into `TokenUsage { inputTokens, outputTokens }` consistently (watch provider-specific cache/Anthropic input breakdowns — pick the canonical fields and document).
3. **`stopReason` normalization:** map provider stop reasons to a small normalized set the loop checks for `end_turn` vs tool use.
4. **Pricing warning is loud and CI-visible** at load time and repeated at runtime; `budget.maxCostUsd: null/0` silences it for that agent (the explicit opt-out — enforced in Sprint 08).
5. **Keep providers behind the interface** so `mockModel` (Sprint 04) and the real clients are interchangeable in the loop and tests.

---

## Exit criteria / acceptance

- A live (or recorded/VCR) `complete()` against Anthropic and OpenAI returns a normalized `CompleteResult` with correct `content`/`usage`/`stopReason`.
- Tier aliases resolve to the spec models; raw model ids infer the correct provider; `apiKeyEnv`/`baseURL` overrides work.
- A simulated `429`/`503` is retried with backoff and succeeds; a `400` is not retried; `Retry-After` is honored; retries add no token budget and emit no loop events.
- `estimateCost` matches `MODEL_PRICING` for known models; an unpriced routable model returns `0` and triggers the warning at load + runtime.
- Custom pricing via `createRuntime({ pricing })` overrides/extends the built-in table.

---

## Risks / open questions

- **Provider SDK vs raw HTTP:** using official SDKs speeds adapters but adds bundle weight (watch the sdk < 100KB target — model clients live in `engine`, not `sdk`, so this is less constrained). Recommend official SDKs in `engine`.
- **Pricing table drift:** `MODEL_PRICING` needs ongoing updates; document the update process and keep it data-only.
- **Structured-output capability matrix:** which models support native `response_format` vs need the prompt fallback — encode capability per model/provider so Sprint 08 picks the right path.
- **Recorded fixtures for CI:** live provider calls are flaky/costly in CI; establish a VCR/cassette approach for adapter tests.
