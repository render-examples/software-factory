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
	let accepted: string | undefined;
	return {
		name: submit.name,
		label: "Submit",
		description: submit.description,
		parameters: submit.parameters as TSchema,
		executionMode: "sequential",
		prepareArguments(args) {
			accepted = undefined;
			if (isEmptyObject(args)) return args as never;
			const out = submit.call(args);
			if (out.isError) throw new Error(out.text);
			accepted = out.text;
			return args as never;
		},
		async execute(_toolCallId, params) {
			const out = accepted === undefined ? submit.call(params) : { text: accepted, isError: false };
			return { content: [{ type: "text", text: out.text }], details: undefined, isError: out.isError, terminate: !out.isError };
		},
	};
}

const isEmptyObject = (args: unknown) => typeof args === "object" && args !== null && Object.keys(args).length === 0;
