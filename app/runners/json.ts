import type { z } from "zod";

/** Parse JSON from model output. Tolerates code fences and leading prose. */
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
