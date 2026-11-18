import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import type { SubmitTool } from "../core/driver.js";
import type { FactoryTool } from "../tools/index.js";

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
