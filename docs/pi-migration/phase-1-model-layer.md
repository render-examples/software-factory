# Phase 1: Replace Model Client Layer with `@earendil-works/pi-ai`

## Objective

Remove the hand-rolled `AnthropicClient`, `OpenAIClient`, retry wrapper, and tier resolution logic from `packages/engine`. Replace with `@earendil-works/pi-ai`, gaining 15+ LLM providers, automatic auth resolution, and upstream maintenance of wire format changes.

## Current State

| File | Lines | Responsibility |
|------|-------|----------------|
| `engine/src/clients/anthropic-client.ts` | 159 | Anthropic Messages API adapter |
| `engine/src/clients/openai-client.ts` | 220 | OpenAI Chat Completions adapter (also used for OpenRouter, Groq, etc. via `baseURL`) |
| `engine/src/clients/retry.ts` | 147 | Exponential backoff + retry wrapper |
| `engine/src/clients/index.ts` | 57 | `resolveClient(spec)` — factory switch on provider |
| `engine/src/tiers.ts` | 71 | Tier table (`small`/`medium`/`large` → model id), `resolveModelSpec()` |
| `engine/src/model.ts` | 114 | `ModelClient` interface, `CompleteArgs`, `CompleteResult`, `MODEL_PRICING`, `estimateCost()` |

**Total: ~768 lines**

Dependencies removed from `engine/package.json`:
- `@anthropic-ai/sdk` (^0.106.0)
- `openai` (^6.45.0)

## Target State

Dependencies added:
- `@earendil-works/pi-ai` (latest)

Files after migration:
- `engine/src/clients/` → **deleted entirely**
- `engine/src/tiers.ts` → **rewritten** (~40 lines): queries `pi-ai`'s model catalog
- `engine/src/model.ts` → **kept** (interface + `estimateCost`): `ModelClient` interface remains the contract between engine and SDK; pricing table updated to pull from `pi-ai` metadata
- `engine/src/pi-model-adapter.ts` → **new** (~80 lines): adapts `pi-ai` `Models` collection to `ModelClient`

## Detailed Design

### 1. The `ModelClient` interface stays

The interface is sound and consumed throughout the SDK. We keep it verbatim:

```typescript
export interface ModelClient {
  complete(args: CompleteArgs): Promise<CompleteResult>;
  stream?(args: CompleteArgs): AsyncGenerator<ModelStreamEvent, CompleteResult>;
}
```

This is a **thin** bridge — Pi's `streamSimple` maps directly to this shape.

### 2. `PiModelAdapter` implementation

```typescript
// engine/src/pi-model-adapter.ts
import type { Models } from "@earendil-works/pi-ai";
import type { ModelClient, CompleteArgs, CompleteResult, ModelStreamEvent } from "./model.js";

export function createPiModelClient(models: Models): ModelClient {
  return {
    async complete(args: CompleteArgs): Promise<CompleteResult> {
      // Use pi-ai's non-streaming path
      const result = await models.complete({
        model: resolvePiModel(args.model),
        system: args.system,
        messages: toApiMessages(args.messages),
        tools: toApiTools(args.tools),
        // ... sampling, signal
      });
      return fromPiResult(result);
    },

    async *stream(args: CompleteArgs): AsyncGenerator<ModelStreamEvent, CompleteResult> {
      const stream = models.streamSimple({
        model: resolvePiModel(args.model),
        system: args.system,
        messages: toApiMessages(args.messages),
        tools: toApiTools(args.tools),
        signal: args.signal,
      });
      // yield text_delta events as they arrive
      // return assembled CompleteResult at end
    },
  };
}
```

### 3. Tier resolution → catalog lookup

Current `resolveModelSpec()` has a hardcoded table:

```typescript
const TIER_TABLE = {
  small: { provider: "anthropic", model: "claude-haiku-4-5" },
  medium: { provider: "anthropic", model: "claude-sonnet-4-6" },
  large: { provider: "anthropic", model: "claude-opus-4-6" },
};
```

New approach: tiers map to model identifiers in `pi-ai`'s catalog. The mapping is still explicit (we choose which model each tier resolves to) but validation that the model exists comes from `pi-ai`:

```typescript
// engine/src/tiers.ts (rewritten)
import type { Models } from "@earendil-works/pi-ai";

const TIER_TABLE: Record<ModelTier, string> = {
  small: "claude-haiku-4-5",
  medium: "claude-sonnet-4-6",
  large: "claude-opus-4-6",
};

export function resolveModelSpec(tier: string | undefined, models: Models): ModelSpec {
  const modelId = TIER_TABLE[tier as ModelTier] ?? tier ?? TIER_TABLE.medium;
  const catalogEntry = models.getModel(modelId);
  if (!catalogEntry) throw new Error(`Model "${modelId}" not found in pi-ai catalog`);
  return { provider: catalogEntry.provider, model: modelId };
}
```

### 4. Boot path change

**Before** (`app/src/server.ts` and `app/src/workflows.ts`):
```typescript
import { resolveClient, resolveModelSpec } from "@render-factory/engine";
const { spec } = resolveModelSpec(process.env.MODEL_TIER ?? "medium");
const model = resolveClient(spec);
```

**After:**
```typescript
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { createPiModelClient, resolveModelSpec } from "@render-factory/engine";

const models = builtinModels();
const spec = resolveModelSpec(process.env.MODEL_TIER ?? "medium", models);
const model = createPiModelClient(models);
```

Note: both `app/src/server.ts` (gateway) and `app/src/workflows.ts` (task host) use identical model resolution and must both be updated.

### 5. Pricing table

`MODEL_PRICING` stays in `model.ts` as the budget enforcement input. It can be auto-populated from `pi-ai`'s catalog metadata when available, with manual overrides for models not yet cataloged:

```typescript
export function buildPricingFromCatalog(models: Models): Record<string, ModelPricing> {
  const pricing: Record<string, ModelPricing> = {};
  for (const entry of models.listModels()) {
    if (entry.pricing) {
      pricing[entry.id] = {
        inputPer1M: entry.pricing.inputPer1M,
        outputPer1M: entry.pricing.outputPer1M,
      };
    }
  }
  return { ...pricing, ...MANUAL_PRICING_OVERRIDES };
}
```

## Challenges and Assumptions

### C1: `pi-ai` message format compatibility

`pi-ai` uses its own message type, not Anthropic's or OpenAI's. We need to translate render-factory's `Message[]` (with `ContentBlock[]`) to `pi-ai`'s message format. This is similar work to what the current Anthropic/OpenAI clients do — just targeting a different shape.

**Assumption:** `pi-ai`'s `LlmMessage` type is documented and stable enough to target.

**Mitigation:** If the format is unstable, we can use `pi-ai`'s provider-specific escape hatch to pass raw Anthropic/OpenAI messages directly.

### C2: Cache control (Anthropic prompt caching)

The current `AnthropicClient` pins `cache_control: { type: "ephemeral" }` on the system prompt for Anthropic's prompt caching. `pi-ai` needs to support this or we lose caching savings.

**Assumption:** `pi-ai` handles prompt caching transparently or exposes a way to annotate messages.

**Mitigation:** If not supported, we keep a thin Anthropic-specific layer that decorates the system message before passing to `pi-ai`. This is a minor compromise (~15 lines).

### C3: `responseFormat` (JSON schema mode)

The current `OpenAIClient` passes `response_format: { type: "json_schema", ... }` for structured output. The `AnthropicClient` shims this into the system prompt. We need the adapter to handle both approaches per provider.

**Assumption:** `pi-ai` normalizes `responseFormat` across providers, or we handle it in the adapter.

**Mitigation:** Structured output logic lives in `DefaultRunner.structuredOutput()` (Phase 2 handles this). In Phase 1, we just need the adapter to pass through `responseFormat` if the provider supports it, or append to system prompt if not.

### C4: Custom `baseURL` / keyless endpoints

The current `OpenAIClient` supports custom `baseURL` for Ollama, vLLM, etc. `pi-ai` handles this via custom provider registration (`pi.registerProvider()`).

**Assumption:** `pi-ai`'s `createModels()` accepts custom provider configs for self-hosted endpoints.

**Mitigation:** Verify this works in `pi-ai`'s `models.json` mechanism or `credentials` option on `createModels()`.

### C5: Bundle size

`pi-ai/providers/all` imports all provider catalogs. If this bloats the Docker image significantly, use selective imports (`pi-ai/providers/anthropic`, `pi-ai/providers/openai`).

**Mitigation:** Measure before/after image size. Pi uses lazy loading for SDK implementations, so catalog imports alone are cheap.

## Migration Steps

1. Install `@earendil-works/pi-ai` in `packages/engine`
2. Write `pi-model-adapter.ts` (adapter + message translation)
3. Rewrite `tiers.ts` to use catalog lookup
4. Update `model.ts` pricing table to optionally pull from catalog
5. Update `app/src/server.ts` boot path
6. Update `app/src/workflows.ts` boot path (same model resolution pattern)
7. Delete `clients/` directory
8. Remove `@anthropic-ai/sdk` and `openai` from `engine/package.json`
9. Update engine `index.ts` exports: remove `AnthropicClient`, `OpenAIClient`, `withRetry`, `resolveClient`; add `createPiModelClient`
10. Update SDK's `runtime.ts`: `resolveClient` import → `createPiModelClient`
11. Update test helpers (`sdk/src/testing.ts`): `mockModel` stays, but add a `mockPiModels()` if tests need catalog access
12. Run full test suite, fix any translation edge cases

## Acceptance Criteria

- `pnpm test` passes across all packages
- `MODEL_TIER=medium` boots and completes a chat turn with Claude Sonnet
- `MODEL_TIER=small` and `MODEL_TIER=large` resolve correctly
- Setting `OPENAI_API_KEY` + `MODEL_TIER=gpt-5` routes through `pi-ai`'s OpenAI provider
- No runtime import of `@anthropic-ai/sdk` or `openai` packages
- Docker image size delta < 10MB (measure with `docker images --format`)
