import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { Harness } from "../harness/types.js";
import type { ToolName } from "../runner/core/protocol.js";
import { outputSchemaProblem } from "../runner/core/submit.js";

export type OutputSchema = z.ZodObject;

export interface AgentSpec<Tools extends readonly ToolName[], Output extends OutputSchema> {
	id: string;
	/** Path to the agent's Markdown prompt, relative to app/agents/. */
	prompt: string;
	/** The agent library and model that run it, from an adapter in app/harness/. */
	harness: Harness;
	/** Tools the agent may call in its sandbox. */
	tools: Tools;
	output: Output;
	maxTurns: number;
}

export interface Agent<Tools extends readonly ToolName[] = readonly ToolName[], Output extends OutputSchema = OutputSchema>
	extends Omit<AgentSpec<Tools, Output>, "prompt"> {
	/** Absolute path of the prompt file. */
	promptPath: string;
	/** The prompt file's contents, verbatim: the agent's system prompt. Read on first use, on the host. */
	readonly prompt: string;
	/** `output` as JSON Schema (input side, so fields with defaults are optional): the runner's submit tool takes it. */
	outputJsonSchema: Record<string, unknown>;
}

const AGENTS_DIR = new URL("./", import.meta.url);

/**
 * Converts the output schema. Agent modules are also bundled into the sandbox runner, where prompt files don't
 * exist, so the prompt is read lazily.
 */
export function defineAgent<const Tools extends readonly ToolName[], Output extends OutputSchema>(
	spec: AgentSpec<Tools, Output>,
): Agent<Tools, Output> {
	if (!Number.isInteger(spec.maxTurns) || spec.maxTurns <= 0) throw new Error(`agent ${spec.id}: maxTurns must be a positive integer`);
	const promptPath = fileURLToPath(new URL(spec.prompt, AGENTS_DIR));
	const outputJsonSchema = z.toJSONSchema(spec.output, { io: "input" }) as Record<string, unknown>;
	const problem = outputSchemaProblem(outputJsonSchema);
	if (problem) throw new Error(`agent ${spec.id}: ${problem}`);
	let prompt: string | undefined;
	const { prompt: _relative, ...rest } = spec;
	return {
		...rest,
		promptPath,
		outputJsonSchema,
		get prompt() {
			if (prompt === undefined) {
				const text = readFileSync(promptPath, "utf8");
				if (!text.trim()) throw new Error(`agent ${spec.id}: prompt file ${promptPath} is empty`);
				prompt = text;
			}
			return prompt;
		},
	};
}
