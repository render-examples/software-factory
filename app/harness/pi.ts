import type { Api, Model, MutableModels } from "@earendil-works/pi-ai";
import { piDriver, type ThinkingLevel } from "../runner/index.js";
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
	 * Providers the model can be resolved and streamed through, such as a custom or self-hosted one. They're added to
	 * Pi's built-in catalog, each replacing a built-in provider with the same ID.
	 */
	models?: () => MutableModels;
	/** The env var holding the key. Default: the provider's, from PI_PROVIDER_KEY_ENV; required for other providers. */
	credential?: string;
	/**
	 * The hosts model requests go to. Default: the host of `model.baseUrl`. Set it when `models` resolves the model
	 * to a different base URL, such as a proxy.
	 */
	egress?: string[];
}

/** Runs an agent on Pi (`@earendil-works/pi-coding-agent`) with the factory's tools. */
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
		egress: opts.egress ?? [new URL(opts.model.baseUrl).hostname],
		driver: piDriver({ model: opts.model, thinkingLevel, models: opts.models }),
	};
}
