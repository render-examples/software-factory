export const MAX_OUTPUT_CHARS = 50_000;
export const MAX_READ_CHARS = 100_000;

/** Keep tool output inside the model's context budget, and say so when cut. */
export function truncate(value: string, limit = MAX_OUTPUT_CHARS): string {
	if (value.length <= limit) return value;
	return `${value.slice(0, limit)}\n... (truncated, ${value.length - limit} chars omitted)`;
}
