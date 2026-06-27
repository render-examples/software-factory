import type { ModelSpec } from "../agent.js";
import type { ModelClient, RetryPolicy } from "../model.js";
import { AnthropicClient } from "./anthropic-client.js";
import { OpenAIClient } from "./openai-client.js";
import { withRetry } from "./retry.js";

export interface ResolveClientOptions {
  retry?: Partial<RetryPolicy>;
}

/**
 * Resolve a ModelClient from a ModelSpec. Reads API keys from env using
 * the spec's `apiKeyEnv` field (defaults to ANTHROPIC_API_KEY / OPENAI_API_KEY).
 * Wraps the result with the retry policy.
 */
export function resolveClient(
  spec: ModelSpec,
  opts?: ResolveClientOptions,
): ModelClient {
  const raw = createProviderClient(spec);
  return withRetry(raw, opts?.retry);
}

function createProviderClient(spec: ModelSpec): ModelClient {
  switch (spec.provider) {
    case "anthropic": {
      const apiKey = readEnv(spec.apiKeyEnv ?? "ANTHROPIC_API_KEY");
      return new AnthropicClient({
        apiKey,
        baseURL: spec.baseURL,
      });
    }
    case "openai": {
      const apiKey = readEnv(spec.apiKeyEnv ?? "OPENAI_API_KEY");
      return new OpenAIClient({
        apiKey,
        baseURL: spec.baseURL,
      });
    }
    default:
      throw new Error(
        `Unsupported provider "${(spec as ModelSpec).provider}". Supported: anthropic, openai`,
      );
  }
}

function readEnv(name: string): string | undefined {
  const value = process.env[name];
  if (!value) {
    console.warn(
      `[render-agents] API key env "${name}" is not set. ` +
      `Model calls will fail until it is configured.`,
    );
  }
  return value;
}
