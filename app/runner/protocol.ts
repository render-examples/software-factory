/**
 * The contract between the host (`runAgent`) and the agent runner, which runs in a sandbox bundled into
 * runner.mjs: input on stdin, events on stdout.
 */
import { z } from "zod";

const TOOL_NAMES = ["read", "ls", "bash", "edit", "write"] as const;
export const ToolName = z.enum(TOOL_NAMES);
export type ToolName = z.infer<typeof ToolName>;

const ThinkingLevel = z.enum(["off", "minimal", "low", "medium", "high"]);

export const RunnerInput = z.object({
	trace_id: z.string().min(1),
	agent_id: z.string().min(1),
	/** The agent's prompt, after `{{name}}` substitution. */
	system_prompt: z.string().min(1),
	/** The task for this run. */
	message: z.string().min(1),
	model_provider: z.string().min(1),
	model: z.string().min(1),
	thinking_level: ThinkingLevel.default("medium"),
	tools: z.array(ToolName),
	/** JSON Schema (an object schema) of the agent's output; the runner's `submit` tool takes exactly this. */
	output_schema: z.record(z.string(), z.unknown()),
	max_turns: z.number().int().positive(),
	timeout_ms: z.number().int().positive(),
	/** Working directory for tools: the repository checkout. Required when `tools` is non-empty. */
	cwd: z.string().min(1).optional(),
	/** The only writable location besides `cwd` (HOME and TMPDIR for tools). */
	scratch_dir: z.string().min(1).optional(),
});
export type RunnerInput = z.infer<typeof RunnerInput>;

export const Usage = z.object({
	input_tokens: z.number().int().nonnegative(),
	output_tokens: z.number().int().nonnegative(),
	cache_read_tokens: z.number().int().nonnegative().default(0),
	cache_write_tokens: z.number().int().nonnegative().default(0),
	cost_usd: z.number().nonnegative().optional(),
});
export type Usage = z.infer<typeof Usage>;

export const RUNNER_ERROR_CODES = [
	"timeout",
	"no_submission",
	"invalid_input",
	"invalid_submission",
	"max_turns",
	"agent_error",
] as const;
export type RunnerErrorCode = (typeof RUNNER_ERROR_CODES)[number];

/** One JSON object per line on the runner's stdout. Exactly one `result` or `error` ends the stream. */
export const RunnerEvent = z.discriminatedUnion("type", [
	z.object({ type: z.literal("started"), at: z.iso.datetime(), agent_id: z.string(), model: z.string(), pi_version: z.string() }),
	z.object({ type: z.literal("tool_call"), at: z.iso.datetime(), tool_call_id: z.string(), tool: z.string(), args: z.unknown() }),
	z.object({
		type: z.literal("tool_result"),
		at: z.iso.datetime(),
		tool_call_id: z.string(),
		tool: z.string(),
		is_error: z.boolean(),
		output_preview: z.string(),
	}),
	z.object({ type: z.literal("assistant_text"), at: z.iso.datetime(), text: z.string() }),
	z.object({ type: z.literal("usage"), at: z.iso.datetime(), usage: Usage }),
	z.object({ type: z.literal("result"), at: z.iso.datetime(), output: z.unknown(), turns: z.number().int().nonnegative() }),
	z.object({ type: z.literal("error"), at: z.iso.datetime(), code: z.enum(RUNNER_ERROR_CODES), message: z.string() }),
]);
export type RunnerEvent = z.infer<typeof RunnerEvent>;

export const RUNNER_EXIT = { ok: 0, error: 1, invalid_input: 2, timeout: 3 } as const;
