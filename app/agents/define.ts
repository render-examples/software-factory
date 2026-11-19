import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { Harness } from "../harness/index.js";
import { outputSchemaProblem, type ToolName } from "../runner/index.js";

export type OutputSchema = z.ZodObject;

export interface AgentSpec<Tools extends readonly ToolName[], Output extends OutputSchema> {
	id: string;
	prompt: string;
	harness: Harness;
	tools: Tools;
	output: Output;
	maxTurns: number;
}

export interface Agent<Tools extends readonly ToolName[] = readonly ToolName[], Output extends OutputSchema = OutputSchema>
	extends Omit<AgentSpec<Tools, Output>, "prompt"> {
	promptPath: string;
	readonly prompt: string;
	outputJsonSchema: Record<string, unknown>;
}

const AGENTS_DIR = new URL("./", import.meta.url);

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
