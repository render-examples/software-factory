import type { Api, Model, MutableModels } from "@earendil-works/pi-ai";
import { piDriver, type ThinkingLevel } from "../runner/index.js";
import type { Harness } from "./types.js";

export type { ThinkingLevel };

export const PI_PROVIDER_KEY_ENV: Readonly<Record<string, string>> = {
	anthropic: "ANTHROPIC_API_KEY",
	google: "GEMINI_API_KEY",
	openai: "OPENAI_API_KEY",
};

export interface PiOptions {
	model: Model<Api>;
	thinkingLevel?: ThinkingLevel;
	models?: () => MutableModels;
	credential?: string;
	egress?: string[];
}

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
