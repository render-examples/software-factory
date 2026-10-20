import {
	type Api,
	type FauxResponseStep as TestStubResponse,
	fauxAssistantMessage as testStubAssistantMessage,
	fauxProvider as testStubProvider,
	fauxText as testStubText,
	fauxToolCall as testStubToolCall,
	type Model,
	type MutableModels,
} from "@earendil-works/pi-ai";
import type { RunnerInput } from "./protocol.js";
import { SUBMIT_TOOL } from "./submit.js";

const TEST_STUB_MODEL = "test-stub";
export type TestStub = (input: RunnerInput) => TestStubResponse[];

/**
 * Adds a provider that returns deterministic test responses instead of calling a model. It carries the requested
 * model's prices, so the runner can cost the stub's token estimates and budgets apply.
 */
export function registerTestStubModel(models: MutableModels, responses: TestStubResponse[], priced: Model<Api>): Model<Api> {
	const { input, output, cacheRead, cacheWrite } = priced.cost;
	const stub = testStubProvider({
		provider: TEST_STUB_MODEL,
		models: [{ id: TEST_STUB_MODEL, reasoning: false, cost: { input, output, cacheRead, cacheWrite } }],
	});
	models.setProvider(stub.provider);
	stub.setResponses(responses);
	return stub.getModel() as Model<Api>;
}

const toolUse = { stopReason: "toolUse" } as const;

/**
 * Deterministic `--test-stub` run: lists the working directory if the agent has `ls`, then submits a minimal value
 * built from the output schema. Exercises the runner end to end without a model (snapshot self-checks, tests).
 */
export const defaultTestStub: TestStub = (input) => {
	const responses: TestStubResponse[] = [];
	if (input.tools.includes("ls")) {
		responses.push(
			testStubAssistantMessage([testStubText("[test-stub] Listing the working directory."), testStubToolCall("ls", {})], toolUse),
		);
	}
	const output = sampleFromSchema(input.output_schema) as Record<string, unknown>;
	responses.push(testStubAssistantMessage(testStubToolCall(SUBMIT_TOOL, output), toolUse));
	return responses;
};

/** A small value that satisfies common JSON Schema keywords (enough for test-stub runs, not a general generator). */
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
