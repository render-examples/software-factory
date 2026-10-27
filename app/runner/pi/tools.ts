import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";
import type { SubmitTool } from "../core/driver.js";
import type { FactoryTool } from "../tools/index.js";

/** A factory tool as a Pi tool. Pi validates the arguments against the same schema before `execute`. */
export function piTool(tool: FactoryTool): AgentTool<TSchema, undefined> {
	return {
		name: tool.name,
		label: tool.name,
		description: tool.description,
		parameters: tool.parameters as TSchema,
		async execute(_toolCallId, params, signal) {
			const out = await tool.execute(params, signal);
			// Pi marks a tool call failed only when execute throws.
			if (out.isError) throw new Error(out.text);
			return { content: [{ type: "text", text: out.text }], details: undefined };
		},
	};
}

/**
 * The submit tool as a Pi tool. Submissions are checked in `prepareArguments`, which runs before Pi's own argument
 * validation: Pi would otherwise reject a call without it counting as an attempt, and coerce values the host's Zod
 * schema would refuse. Sequential, so each `execute` follows its own `prepareArguments`.
 */
export function piSubmitTool(submit: SubmitTool): AgentTool<TSchema, undefined> {
	let text = "";
	return {
		name: submit.name,
		label: "Submit",
		description: submit.description,
		parameters: submit.parameters as TSchema,
		executionMode: "sequential",
		prepareArguments(args) {
			const out = submit.call(args);
			if (out.isError) throw new Error(out.text);
			text = out.text;
			return args as never;
		},
		async execute() {
			return { content: [{ type: "text", text }], details: undefined, terminate: true };
		},
	};
}
