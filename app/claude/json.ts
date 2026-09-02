import type { z } from "zod";

/**
 * Parse strict JSON from an agent, tolerating a code fence or leading prose.
 * Returns null rather than throwing so callers choose their own fallback.
 */
export function parseModelJson<T>(schema: z.ZodType<T>, raw: string): T | null {
	const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
	const candidate =
		fenced ?? raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
	try {
		return schema.parse(JSON.parse(candidate));
	} catch {
		return null;
	}
}
