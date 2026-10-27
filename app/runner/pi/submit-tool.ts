import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";
import { SUBMIT_ACCEPTED, SUBMIT_DUPLICATE, SUBMIT_TOOL, type Submission, submitDescription, submitParameters } from "../core/submit.js";

/**
 * Pi's submit tool: its parameters are the agent's output schema. Submissions are checked in `prepareArguments`,
 * which runs before Pi's own argument validation (which would otherwise reject a call without counting it, and
 * coerce values the host's Zod schema would refuse). `onExhausted` gets the failure message after the last
 * allowed rejection.
 */
export function createSubmitTool(
	schema: Record<string, unknown>,
	submission: Submission,
	onExhausted: (message: string) => void,
): AgentTool<TSchema, unknown> {
	/** The arguments as checked, before Pi's validation coerces them; calls run one at a time (sequential). */
	let checked: unknown;
	return {
		name: SUBMIT_TOOL,
		label: "Submit",
		description: submitDescription(schema),
		parameters: submitParameters(schema) as TSchema,
		executionMode: "sequential",
		prepareArguments(args) {
			if (submission.accepted) return args;
			const verdict = submission.check(args);
			if (verdict.ok) {
				checked = verdict.checked;
				return args;
			}
			if (verdict.exhausted) onExhausted(verdict.exhausted);
			throw new Error(verdict.message);
		},
		async execute(_toolCallId, params) {
			const output = checked ?? params;
			if (!submission.accept(output)) {
				return { content: [{ type: "text", text: SUBMIT_DUPLICATE }], details: submission.accepted?.output, terminate: true };
			}
			return { content: [{ type: "text", text: SUBMIT_ACCEPTED }], details: output, terminate: true };
		},
	};
}
