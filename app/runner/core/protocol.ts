import { z } from "zod";

export const PROTOCOL_VERSION = 3;

export const TOOL_NAMES = ["read", "ls", "bash", "edit", "write"] as const;
export const ToolName = z.enum(TOOL_NAMES);
export type ToolName = z.infer<typeof ToolName>;

export const RunnerInput = z.object({
	protocol_version: z.literal(PROTOCOL_VERSION),
	trace_id: z.string().min(1),
	agent_id: z.string().min(1),
	system_prompt: z.string().min(1),
	message: z.string().min(1),
	tools: z.array(ToolName),
	output_schema: z.record(z.string(), z.unknown()),
	max_turns: z.number().int().positive(),
	timeout_ms: z.number().int().positive(),
	cwd: z.string().min(1).optional(),
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

const RUNNER_ERROR_CODES = ["timeout", "no_submission", "invalid_input", "invalid_submission", "max_turns", "agent_error"] as const;
export type RunnerErrorCode = (typeof RUNNER_ERROR_CODES)[number];

export const RunnerEvent = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("started"),
		at: z.iso.datetime(),
		agent_id: z.string(),
		harness: z.string(),
		harness_version: z.string(),
		model: z.string(),
	}),
	z.object({ type: z.literal("tool_call"), at: z.iso.datetime(), tool_call_id: z.string(), tool: z.string(), args: z.unknown() }),
	z.object({
		type: z.literal("tool_result"),
		at: z.iso.datetime(),
		tool_call_id: z.string(),
		tool: z.string(),
		is_error: z.boolean(),
		output_preview: z.string(),
	}),
	z.object({ type: z.literal("assistant_delta"), at: z.iso.datetime(), message_id: z.string(), text: z.string() }),
	z.object({ type: z.literal("assistant_text"), at: z.iso.datetime(), message_id: z.string(), text: z.string() }),
	z.object({ type: z.literal("usage"), at: z.iso.datetime(), usage: Usage }),
	z.object({ type: z.literal("result"), at: z.iso.datetime(), output: z.unknown(), turns: z.number().int().nonnegative() }),
	z.object({ type: z.literal("error"), at: z.iso.datetime(), code: z.enum(RUNNER_ERROR_CODES), message: z.string() }),
]);
export type RunnerEvent = z.infer<typeof RunnerEvent>;

export const RUNNER_EXIT = { ok: 0, error: 1, invalid_input: 2, timeout: 3 } as const;
