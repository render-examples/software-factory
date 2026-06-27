import type { ModelSpec, ModelTier } from "./agent.js";

export interface TierEntry {
  provider: "anthropic" | "openai";
  model: string;
}

const TIER_TABLE: Record<ModelTier, TierEntry> = {
  small: { provider: "anthropic", model: "claude-haiku-4-5" },
  medium: { provider: "anthropic", model: "claude-sonnet-4-6" },
  large: { provider: "anthropic", model: "claude-opus-4-6" },
};

const TIER_ALIASES = new Set<string>(Object.keys(TIER_TABLE));

const SUPPORTED_PROVIDERS = new Set(["anthropic", "openai"]);

export function isTierAlias(value: string): value is ModelTier {
  return TIER_ALIASES.has(value);
}

export function inferProvider(model: string): "anthropic" | "openai" | undefined {
  if (model.startsWith("claude")) return "anthropic";
  if (model.startsWith("gpt") || model.startsWith("o1") || model.startsWith("o3")) return "openai";
  return undefined;
}

export interface ResolveModelResult {
  spec: ModelSpec;
  warnings: string[];
}

/**
 * Resolve a model string (tier alias or raw model id) + optional provider into a ModelSpec.
 * Returns the resolved spec and any warnings (e.g. unpriced model).
 * Throws on routing/tier validity failures.
 */
export function resolveModelSpec(
  model: string | undefined,
  provider?: "anthropic" | "openai",
): ResolveModelResult {
  const effectiveModel = model ?? "medium";
  const warnings: string[] = [];

  if (isTierAlias(effectiveModel)) {
    const entry = TIER_TABLE[effectiveModel];
    return {
      spec: { provider: entry.provider, model: entry.model },
      warnings,
    };
  }

  const resolvedProvider = provider ?? inferProvider(effectiveModel);
  if (!resolvedProvider) {
    throw new Error(
      `Cannot route model "${effectiveModel}" to a supported provider. ` +
      `Set "provider" explicitly or use a recognized model name.`,
    );
  }

  if (!SUPPORTED_PROVIDERS.has(resolvedProvider)) {
    throw new Error(
      `Provider "${resolvedProvider}" is not supported. Supported: ${[...SUPPORTED_PROVIDERS].join(", ")}`,
    );
  }

  return {
    spec: { provider: resolvedProvider, model: effectiveModel },
    warnings,
  };
}
