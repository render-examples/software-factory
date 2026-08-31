/**
 * ModelResolver — maps abstract size tiers to concrete model identifiers.
 *
 * Agents declare a size (small/medium/large) or a literal model string.
 * Each runner ships a default tier map; swap in a custom resolver to
 * route through LiteLLM, a model gateway, or per-environment overrides.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ModelTier = "small" | "medium" | "large";

export interface ResolvedModel {
  readonly model: string;
  /** Override the SDK's default API base URL (e.g. point at a LiteLLM proxy). */
  readonly baseUrl?: string;
}

export interface ModelResolver {
  resolve(tierOrModel: ModelTier | string): ResolvedModel;
}

// ---------------------------------------------------------------------------
// Static resolver — default implementation backed by a plain map
// ---------------------------------------------------------------------------

export type TierMap = Record<ModelTier, string>;

export class StaticModelResolver implements ModelResolver {
  constructor(
    private readonly tiers: TierMap,
    private readonly baseUrl?: string,
  ) {}

  resolve(tierOrModel: ModelTier | string): ResolvedModel {
    const model =
      Object.hasOwn(this.tiers, tierOrModel)
        ? this.tiers[tierOrModel as ModelTier]
        : tierOrModel;

    if (typeof model !== "string" || model.length === 0) {
      throw new Error(`Invalid model resolution for "${tierOrModel}"`);
    }
    return { model, ...(this.baseUrl && { baseUrl: this.baseUrl }) };
  }
}

// ---------------------------------------------------------------------------
// Claude defaults
// ---------------------------------------------------------------------------

export const CLAUDE_TIERS: TierMap = {
  small: "claude-haiku-4-5",
  medium: "claude-sonnet-5",
  large: "claude-opus-5",
};

export function createClaudeModelResolver(
  overrides?: Partial<TierMap>,
  baseUrl?: string,
): ModelResolver {
  return new StaticModelResolver(
    { ...CLAUDE_TIERS, ...overrides },
    baseUrl,
  );
}
