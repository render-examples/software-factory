import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { pi } from "../harness/index.js";

/**
 * The harnesses the built-in agents use. Change an agent's library or model here, or give an agent its own
 * harness in its definition. Each value carries its library's own configuration, so a typo in a model ID is a
 * type error.
 */
export const medium = pi({ model: getBuiltinModel("anthropic", "claude-sonnet-5") });
export const large = pi({ model: getBuiltinModel("anthropic", "claude-opus-5") });
