import type { Api, Model } from "@earendil-works/pi-ai";
import { createModels, PI_VERSION, runPiSession, type ThinkingLevel } from "../runner/pi/session.js";
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
}

/** Runs an agent on Pi (`@earendil-works/pi-agent-core`) with the factory's tools. */
export function pi(opts: PiOptions): Harness {
	const { provider, id } = opts.model;
	const credential = PI_PROVIDER_KEY_ENV[provider];
	if (!credential) throw new Error(`pi: provider "${provider}" is not supported; use one of ${Object.keys(PI_PROVIDER_KEY_ENV).join(", ")}`);
	const thinkingLevel = opts.thinkingLevel ?? "medium";
	return {
		name: "pi",
		label: `${provider}/${id}`,
		credential,
		run: (run) => runPiSession(run, { model: opts.model, thinkingLevel }),
		async selfTest() {
			const known = createModels().getModel(provider, id);
			return { version: PI_VERSION, problems: known ? [] : [`pi: model ${provider}/${id} is not in the Pi ${PI_VERSION} registry`] };
		},
	};
}
