import type { Api, Model, MutableModels } from "@earendil-works/pi-ai";
import { piDriver, type ThinkingLevel } from "../runner/pi/driver.js";
import type { Harness } from "./types.js";

export type { ThinkingLevel };

/** Each provider's key env var, for the providers the factory supports through Pi. */
export const PI_PROVIDER_KEY_ENV: Readonly<Record<string, string>> = {
	anthropic: "ANTHROPIC_API_KEY",
	google: "GEMINI_API_KEY",
	openai: "OPENAI_API_KEY",
};

export interface PiOptions {
	/** A model from Pi's catalog, e.g. `getBuiltinModel("anthropic", "claude-opus-5")`. */
	model: Model<Api>;
	/** Default "medium". */
	thinkingLevel?: ThinkingLevel;
	/**
	 * The Pi model registry the model is resolved and streamed through: a custom or self-hosted provider registered
	 * on it. Default: Pi's built-in catalog.
	 */
	models?: () => MutableModels;
	/** The env var holding the key. Default: the provider's, from PI_PROVIDER_KEY_ENV; required for other providers. */
	credential?: string;
}

/** Runs an agent on Pi (`@earendil-works/pi-agent-core`) with the factory's tools. */
export function pi(opts: PiOptions): Harness {
	const { provider, id } = opts.model;
	const credential = opts.credential ?? PI_PROVIDER_KEY_ENV[provider];
	if (!credential) {
		throw new Error(`pi: no default key for provider "${provider}"; pass credential, or use one of ${Object.keys(PI_PROVIDER_KEY_ENV).join(", ")}`);
	}
	const thinkingLevel = opts.thinkingLevel ?? "medium";
	return {
		name: "pi",
		label: `${provider}/${id}`,
		credential,
		driver: piDriver({ model: opts.model, thinkingLevel, models: opts.models }),
	};
}
