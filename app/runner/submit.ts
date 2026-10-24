import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";

export const SUBMIT_TOOL = "submit";
export const MAX_SUBMIT_ATTEMPTS = 3;

type JsonOutputSchema = Record<string, unknown>;

/**
 * Why `schema` can't be a submit tool's parameters, or undefined if it can. Pi's Anthropic adapter sends only
 * the top-level `properties` and `required`, so the root must be a plain object schema, not a union or a ref.
 */
export function outputSchemaProblem(schema: JsonOutputSchema): string | undefined {
	if (schema.type !== "object") return 'output_schema must have type "object" at its root';
	const props = schema.properties;
	if (typeof props !== "object" || props === null || Array.isArray(props)) {
		return "output_schema must have a properties object at its root";
	}
	try {
		Value.Check(schema as TSchema, {});
	} catch (err) {
		return `output_schema is not a usable JSON Schema: ${err instanceof Error ? err.message : String(err)}`;
	}
	return undefined;
}

type Verdict = { ok: true } | { ok: false; problems: string[] };

/**
 * Checks a submission against the output JSON Schema with TypeBox, which validates plain JSON Schema (including
 * what `z.toJSONSchema` emits). A usability check so the model can fix its submission: the host revalidates
 * the accepted output with the agent's Zod schema, and that check is authoritative.
 */
function checkSubmission(schema: JsonOutputSchema, candidate: unknown): Verdict {
	if (Value.Check(schema as TSchema, candidate)) return { ok: true };
	const problems = [...Value.Errors(schema as TSchema, candidate)].map((e) => `${e.instancePath || "(root)"}: ${e.message}`);
	return { ok: false, problems: problems.length > 0 ? [...new Set(problems)] : ["(root): does not match the output schema"] };
}

interface SubmitHandlers {
	onAccepted(output: unknown): void;
	/** Called with the number of rejected attempts so far. */
	onRejected(attempts: number): void;
}

/** The tool's parameters as the model sees them: the output schema without JSON Schema metadata. */
function toolParameters(schema: JsonOutputSchema): TSchema {
	const { $schema: _schema, $id: _id, ...rest } = schema;
	return rest as TSchema;
}

/**
 * The generic submit tool: its parameters are the agent's output schema. Submissions are checked in
 * `prepareArguments`, which runs before Pi's own argument validation (which would otherwise reject a call
 * without counting it, and coerce values the host's Zod schema would refuse).
 */
export function createSubmitTool(schema: JsonOutputSchema, handlers: SubmitHandlers): AgentTool<TSchema, unknown> {
	let accepted: { output: unknown } | undefined;
	/** The arguments as checked, before Pi's validation coerces them; calls run one at a time (sequential). */
	let checked: unknown;
	let rejected = 0;
	const what = typeof schema.description === "string" && schema.description ? ` ${schema.description}` : "";
	return {
		name: SUBMIT_TOOL,
		label: "Submit",
		description:
			`Submit your final output.${what} Call it exactly once, as your final action, on its own. The arguments are ` +
			"checked against the schema; a rejected submission records nothing, so fix every listed problem and call it " +
			`again (${MAX_SUBMIT_ATTEMPTS} attempts in total).`,
		parameters: toolParameters(schema),
		executionMode: "sequential",
		prepareArguments(args) {
			if (accepted) return args;
			const verdict = checkSubmission(schema, args);
			if (verdict.ok) {
				checked = structuredClone(args);
				return args;
			}
			rejected++;
			const remaining = MAX_SUBMIT_ATTEMPTS - rejected;
			handlers.onRejected(rejected);
			throw new Error(
				`${SUBMIT_TOOL} rejected (attempt ${rejected} of ${MAX_SUBMIT_ATTEMPTS}); nothing was recorded. ` +
					(remaining > 0 ? "Fix every problem below and call it again:\n" : "No attempts remain:\n") +
					verdict.problems.map((p) => `- ${p}`).join("\n"),
			);
		},
		async execute(_toolCallId, params) {
			if (accepted) {
				return { content: [{ type: "text", text: "Already submitted; this call was ignored." }], details: accepted.output, terminate: true };
			}
			const output = checked ?? params;
			accepted = { output };
			handlers.onAccepted(output);
			return { content: [{ type: "text", text: "Submission recorded. You are done." }], details: output, terminate: true };
		},
	};
}
