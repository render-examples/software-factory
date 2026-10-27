import type { RunnerInput, TestTurn } from "./protocol.js";
import { SUBMIT_TOOL } from "./submit.js";

/**
 * The `--test-stub` script when the input has none: lists the working directory if the agent has `ls`, then
 * submits a minimal value built from the output schema. Exercises a harness end to end without a model (snapshot
 * self-checks, tests).
 */
export function defaultTestScript(input: RunnerInput): TestTurn[] {
	const turns: TestTurn[] = [];
	if (input.tools.includes("ls")) turns.push({ text: "[test-stub] Listing the working directory.", calls: [{ name: "ls", args: {} }] });
	turns.push({ calls: [{ name: SUBMIT_TOOL, args: sampleFromSchema(input.output_schema) as Record<string, unknown> }] });
	return turns;
}

/** A small value that satisfies common JSON Schema keywords (enough for test-stub runs, not a general generator). */
function sampleFromSchema(schema: unknown): unknown {
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
			return "[test-stub]".padEnd(min, ".");
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
