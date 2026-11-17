import type { z } from "zod";

/**
 * One type of event in the log. Bump `version` whenever the payload schema changes; readers handle every version
 * still in the log. Bound every string and array, and give no schema a free-form field for keys or tokens.
 */
export interface EventSpec<S extends z.ZodType = z.ZodType> {
	readonly type: string;
	readonly version: number;
	readonly payload: S;
}

/** Every event type the factory writes is declared in this file with `defineEvent`. */
export function defineEvent<S extends z.ZodType>(type: string, version: number, payload: S): EventSpec<S> {
	return { type, version, payload };
}
