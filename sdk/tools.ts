/**
 * Tool system — custom tools and built-in markers.
 * Agents declare tools as values; the runner receives them directly.
 */
import type { z } from "zod";
import type { Environment } from "./environment.js";

export type ZodShape = Record<string, z.ZodType>;

/** Infer the TS type from a raw Zod shape (e.g. `{ url: z.string() }`). */
export type InferShape<T extends ZodShape> = z.output<z.ZodObject<T>>;

export interface ToolContext {
  readonly agentId: string;
  /** Workflow-owned execution environment, already resolved to live objects. */
  readonly environment?: Environment;
  readonly signal?: AbortSignal;
}

export interface ToolResult {
  readonly content: string;
  readonly isError?: boolean;
}

export interface Tool<Schema extends ZodShape = ZodShape> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Schema;
  invoke(input: InferShape<Schema>, ctx: ToolContext): Promise<ToolResult>;
}

export interface BuiltInTool {
  readonly name: string;
  readonly builtIn: true;
}

export type ResolvedTool = Tool | BuiltInTool;

export function isBuiltIn(tool: ResolvedTool): tool is BuiltInTool {
  return "builtIn" in tool && tool.builtIn === true;
}

export function isCustomTool(tool: ResolvedTool): tool is Tool {
  return !isBuiltIn(tool);
}
