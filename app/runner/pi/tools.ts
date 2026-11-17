import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import type { SubmitTool } from "../core/driver.js";
import type { FactoryTool } from "../tools/index.js";

/**
 * A factory tool as a Pi tool. Pi validates the arguments against the same schema before `execute`. `endsBatch` is
 * read after the tool runs: true sets `terminate`, which ends the loop once every result in the batch sets it.
 */
export function piTool(tool: FactoryTool, endsBatch: () => boolean): ToolDefinition {
	return {
		name: tool.name,
		label: tool.name,
		description: tool.description,
		parameters: tool.parameters as TSchema,
		async execute(_toolCallId, params, signal) {
			const out = await tool.execute(params, signal);
			return { content: [{ type: "text", text: out.text }], details: undefined, isError: out.isError, terminate: endsBatch() };
		},
	};
}

/**
 * The submit tool as a Pi tool. Submissions are checked in `prepareArguments`, which runs before Pi's own argument
 * validation: Pi would otherwise reject a call without it counting as an attempt, and coerce values the host's Zod
 * schema would refuse. Sequential, so each `execute` follows its own `prepareArguments`.
 */
export function piSubmitTool(submit: SubmitTool): ToolDefinition {
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
