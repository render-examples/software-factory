import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { ModelTier } from "../config/index.js";
import type { RunnerInput, ToolName } from "../runner/protocol.js";
import { outputSchemaProblem } from "../runner/submit.js";

export type ThinkingLevel = RunnerInput["thinking_level"];
export type OutputSchema = z.ZodObject;

export interface AgentSpec<Tools extends readonly ToolName[], Output extends OutputSchema> {
	id: string;
	/** File name of the agent's markdown prompt, relative to app/agents/. */
	prompt: string;
	model: ModelTier;
	/** Empty for an agent that runs in a Workflows task; any tool means it runs in a sandbox. */
	tools: Tools;
	output: Output;
	maxTurns: number;
	thinking?: ThinkingLevel;
}

export interface Agent<Tools extends readonly ToolName[] = readonly ToolName[], Output extends OutputSchema = OutputSchema>
	extends Omit<AgentSpec<Tools, Output>, "prompt"> {
	/** Absolute path of the prompt file. */
	promptPath: string;
	/** The prompt file's contents, verbatim, with `{{name}}` placeholders still in place. */
	prompt: string;
	/** `output` as JSON Schema (input side, so fields with defaults are optional): the runner's submit tool takes it. */
	outputJsonSchema: Record<string, unknown>;
}

const AGENTS_DIR = new URL("./", import.meta.url);

/** Reads the prompt file once, as a string (no frontmatter, no parsing), and converts the output schema. */
export function defineAgent<const Tools extends readonly ToolName[], Output extends OutputSchema>(
	spec: AgentSpec<Tools, Output>,
): Agent<Tools, Output> {
	if (!Number.isInteger(spec.maxTurns) || spec.maxTurns <= 0) throw new Error(`agent ${spec.id}: maxTurns must be a positive integer`);
	const promptPath = fileURLToPath(new URL(spec.prompt, AGENTS_DIR));
	const prompt = readFileSync(promptPath, "utf8");
	if (!prompt.trim()) throw new Error(`agent ${spec.id}: prompt file ${promptPath} is empty`);
	const outputJsonSchema = z.toJSONSchema(spec.output, { io: "input" }) as Record<string, unknown>;
	const problem = outputSchemaProblem(outputJsonSchema);
	if (problem) throw new Error(`agent ${spec.id}: ${problem}`);
	return { ...spec, promptPath, prompt, outputJsonSchema };
}
