import type { z } from "zod";
import { parseModelJson } from "../runners/index.js";

export type AgentCall = (message: string) => string | Promise<string>;

/**
 * Call an agent that must return JSON. One repair attempt, then fail closed.
 */
export async function agentJson<T>(
	call: AgentCall,
	schema: z.ZodType<T>,
	message: string,
	stage: string,
): Promise<T> {
	const parsed = parseModelJson(schema, await call(message));
	if (parsed) return parsed;

	console.warn(JSON.stringify({ event: "model_json_repair", stage }));
	const repaired = parseModelJson(
		schema,
		await call(
			`${message}\n\nYour previous response was not valid JSON. Return only the required JSON object.`,
		),
	);
	if (repaired) return repaired;

	throw new Error(`${stage} returned invalid structured output twice`);
}
