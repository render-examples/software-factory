import type { z } from "zod";
import type { Sandbox } from "../sandbox/index.js";

export type ZodShape = Record<string, z.ZodType>;

/** Infer the argument type from a raw Zod shape (e.g. `{ path: z.string() }`). */
export type InferShape<T extends ZodShape> = z.output<z.ZodObject<T>>;

export interface ToolContext {
	/** Bound by workflow code. A tool can never choose its own sandbox. */
	readonly sandbox: Sandbox;
	readonly signal?: AbortSignal;
}

export interface ToolResult {
	readonly content: string;
	readonly isError?: boolean;
	/** Optional images returned alongside text (e.g. screenshots). */
	readonly images?: ReadonlyArray<{ png: Buffer }>;
}

export interface Tool<Schema extends ZodShape = ZodShape> {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: Schema;
	invoke(input: InferShape<Schema>, ctx: ToolContext): Promise<ToolResult>;
}
