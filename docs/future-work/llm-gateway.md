# LLM Gateway Integration

## Motivation

An LLM gateway sits between the engine and provider APIs, adding:

1. **Unified routing** — single endpoint, model-string routing to many providers
2. **Observability** — latency, cost, error rates per model/agent
3. **Fallbacks & load balancing** — automatic failover between providers
4. **Rate limiting & caching** — semantic caching, per-key rate limits
5. **Guardrails** — PII filtering, content policies before/after

## Current State

The engine already has a pluggable `ModelClient` interface:

```typescript
export interface ModelClient {
  complete(args: CompleteArgs): Promise<CompleteResult>;
  stream?(args: CompleteArgs): AsyncGenerator<ModelStreamEvent, CompleteResult>;
}
```

Client resolution in `packages/engine/src/clients/index.ts` does a hard `switch` on `ModelSpec.provider` (currently `"anthropic" | "openai"`). The `OpenAIClient` already works with any OpenAI-compatible endpoint via `baseURL` — this covers LiteLLM Proxy, Portkey, Helicone, Braintrust, and others out of the box.

---

## Integration Tiers

### Tier 0: Zero Code Changes (Works Today)

Most gateways expose an OpenAI-compatible API. Configure `baseURL` and `apiKeyEnv` on the `ModelSpec`:

```yaml
# Agent frontmatter or project config
model:
  provider: openai
  model: anthropic/claude-sonnet-4-6   # gateway routes by model string
  baseURL: http://localhost:4000        # LiteLLM / Portkey / your gateway
  apiKeyEnv: GATEWAY_API_KEY
```

This works **now** with zero changes. Limitations: no gateway-specific features (metadata headers, semantic caching, fallback chains).

### Tier 1: First-Class Provider Type (~50 lines)

Add `"gateway"` to the `ModelSpec.provider` union so agents can declare intent:

```typescript
export interface ModelSpec {
  provider: "anthropic" | "openai" | "gateway";
  model: string;
  baseURL?: string;
  apiKeyEnv?: string;
}
```

In `resolveClient`:

```typescript
case "gateway": {
  // Delegates to OpenAIClient with the gateway's baseURL
  const apiKey = readEnv(spec.apiKeyEnv ?? "GATEWAY_API_KEY");
  return new OpenAIClient({ apiKey, baseURL: spec.baseURL ?? process.env.LLM_GATEWAY_URL });
}
```

### Tier 2: Gateway Client with Metadata (~150 lines)

A dedicated `GatewayClient` that enriches requests with agent/run context for per-agent observability in the gateway dashboard:

```typescript
// packages/engine/src/clients/gateway-client.ts

export interface GatewayConfig {
  baseURL: string;
  apiKeyEnv?: string;
  /** Static headers sent on every request (org ID, project name). */
  headers?: Record<string, string>;
  /** Auto-inject runId, agentName, threadId as request metadata. */
  metadataFromRun?: boolean;
  /** Enable semantic cache control headers. */
  cacheEnabled?: boolean;
  /** Model fallback chain (gateway routes to next on failure). */
  fallbacks?: string[];
}

export class GatewayClient implements ModelClient {
  private inner: OpenAIClient;
  private config: GatewayConfig;

  constructor(config: GatewayConfig) {
    this.config = config;
    this.inner = new OpenAIClient({
      apiKey: readEnv(config.apiKeyEnv ?? "GATEWAY_API_KEY"),
      baseURL: config.baseURL,
    });
  }

  async complete(args: CompleteArgs): Promise<CompleteResult> {
    // Enrich with metadata headers, cache control, fallback config
    return this.inner.complete(args);
  }

  async *stream(args: CompleteArgs): AsyncGenerator<ModelStreamEvent, CompleteResult> {
    return yield* this.inner.stream!(args);
  }
}
```

### Tier 3: Cost Passthrough from Gateway Headers (~25 lines)

Most gateways return actual cost in response headers (e.g. `x-litellm-response-cost`). Parse this instead of estimating locally:

```typescript
// In the model pricing path
if (responseHeaders?.["x-litellm-response-cost"]) {
  return parseFloat(responseHeaders["x-litellm-response-cost"]);
}
// Fall back to local estimation
return estimateCost(model, usage, pricing);
```

### Tier 4: Project-Level Default with Per-Agent Override (~30 lines)

Make the gateway a runtime-level config so all agents route through it by default:

```typescript
export interface RuntimeOptions {
  // ...existing fields...
  gateway?: GatewayConfig;   // project-level default
}
```

Individual agents can still set `provider: "anthropic"` to bypass the gateway (e.g. for latency-sensitive triage agents).

---

## Runtime Configuration

```typescript
createRuntime({
  gateway: {
    baseURL: process.env.LLM_GATEWAY_URL ?? "http://localhost:4000",
    apiKeyEnv: "GATEWAY_API_KEY",
    metadataFromRun: true,
    cacheEnabled: true,
    fallbacks: ["claude-sonnet-4-6", "gpt-4o"],
  },
});
```

### Environment variables

```bash
LLM_GATEWAY_URL=https://gateway.example.com
GATEWAY_API_KEY=sk-gw-...
```

---

## Gateway Options

| Gateway | Self-hosted | Managed | OpenAI-compat | Key features |
|---------|:-----------:|:-------:|:-------------:|--------------|
| **LiteLLM Proxy** | ✓ | ✓ | ✓ | 100+ providers, fallbacks, budgets, key management |
| **Portkey** | ✗ | ✓ | ✓ | Guardrails, caching, load balancing, analytics |
| **Helicone** | ✗ | ✓ | ✓ | Observability-first, cost tracking, rate limiting |
| **Braintrust Proxy** | ✓ | ✓ | ✓ | Evals-integrated, caching, logging |
| **Custom (nginx + lua)** | ✓ | ✗ | ✓ | Full control, lightweight, no vendor lock |

For self-hosted on Render: deploy LiteLLM Proxy as a private service, reachable over the private network with no public exposure.

---

## Retry Interaction

The engine already wraps clients with `withRetry`. When using a gateway:

- **Option A**: Let the gateway handle retries (disable engine-level retry for gateway-routed calls). Gateway has better visibility into provider health.
- **Option B**: Keep engine retry as a second layer. Gateway retries across providers (failover); engine retries for transient network issues to the gateway itself.

Recommended: **Option B** with reduced engine retries (1-2 attempts, short delay) since the gateway handles the heavy lifting.

---

## Effort Estimate

| Tier | Lines | Time |
|------|-------|------|
| Tier 0 (config only) | 0 | 5min |
| Tier 1 (provider type) | ~50 | 30min |
| Tier 2 (metadata client) | ~150 | 2hr |
| Tier 3 (cost passthrough) | ~25 | 15min |
| Tier 4 (project-level default) | ~30 | 15min |

**Full implementation (Tiers 1–4): ~255 lines, half a day.**

---

## Open Questions

- Should the gateway be mandatory in production (force all traffic through it for auditability), or always optional?
- Do we want per-agent model overrides to also go through the gateway (just with a different model string), or bypass entirely?
- For self-hosted gateways on Render: deploy as a private service alongside the workflows host, or as a shared service across multiple factory instances?
