import {
	type Api,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
	type Model,
	type MutableModels,
} from "@earendil-works/pi-ai";
import type { RunnerInput } from "./protocol.js";
import { SUBMIT_TOOL } from "./submit.js";

export const FAUX_MODEL = "faux";
export type FauxScript = (input: RunnerInput) => FauxResponseStep[];

/**
 * Adds a provider that replays `steps` instead of calling a model, and returns its model. It carries the
 * requested model's prices, so the runner can cost the faux provider's token estimates and budgets apply.
 */
export function registerFauxModel(models: MutableModels, steps: FauxResponseStep[], priced: Model<Api>): Model<Api> {
	const { input, output, cacheRead, cacheWrite } = priced.cost;
	const faux = fauxProvider({ provider: FAUX_MODEL, models: [{ id: FAUX_MODEL, reasoning: false, cost: { input, output, cacheRead, cacheWrite } }] });
	models.setProvider(faux.provider);
	faux.setResponses(steps);
	return faux.getModel() as Model<Api>;
}

const toolUse = { stopReason: "toolUse" } as const;

/**
 * Deterministic `--faux` run: lists the working directory if the agent has `ls`, then submits a minimal value
 * built from the output schema. Exercises the runner end to end without a model (snapshot self-checks, tests).
 */
export const defaultFauxScript: FauxScript = (input) => {
	const steps: FauxResponseStep[] = [];
	if (input.tools.includes("ls")) {
		steps.push(fauxAssistantMessage([fauxText("[faux] Listing the working directory."), fauxToolCall("ls", {})], toolUse));
	}
	const output = sampleFromSchema(input.output_schema) as Record<string, unknown>;
	steps.push(fauxAssistantMessage(fauxToolCall(SUBMIT_TOOL, output), toolUse));
	return steps;
};

/** A small value that satisfies common JSON Schema keywords (enough for faux runs, not a general generator). */
export function sampleFromSchema(schema: unknown): unknown {
	if (typeof schema !== "object" || schema === null) return null;
	const s = schema as Record<string, unknown>;
	if ("const" in s) return s.const;
	if (Array.isArray(s.enum) && s.enum.length > 0) return s.enum[0];
	if (s.default !== undefined) return s.default;
	const variants = (s.anyOf ?? s.oneOf) as unknown[] | undefined;
	if (Array.isArray(variants) && variants.length > 0) {
		const nonNull = variants.find((v) => (v as { type?: unknown })?.type !== "null");
		return sampleFromSchema(nonNull ?? variants[0]);
	}
	const types = Array.isArray(s.type) ? s.type : [s.type];
	const type = types.find((t) => t !== "null") ?? types[0];
	switch (type) {
		case "object": {
			const props = (s.properties ?? {}) as Record<string, unknown>;
			const required = Array.isArray(s.required) ? (s.required as string[]) : [];
			return Object.fromEntries(required.map((key) => [key, sampleFromSchema(props[key])]));
		}
		case "array":
			return Array.from({ length: typeof s.minItems === "number" ? s.minItems : 0 }, () => sampleFromSchema(s.items));
		case "string": {
			const min = typeof s.minLength === "number" ? s.minLength : 0;
			return "[faux]".padEnd(min, ".");
		}
		case "integer":
		case "number":
			return typeof s.minimum === "number" && s.minimum > 0 ? s.minimum : 0;
		case "boolean":
			return false;
		case "null":
			return null;
		default:
			return null;
	}
}
