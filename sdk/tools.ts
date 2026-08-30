/**
 * Tool system — interfaces for custom tools, sources, and a registry.
 *
 * Agents declare tools by string name. The registry resolves those names into
 * either built-in tools (handled natively by the runner's SDK) or custom tools
 * (bridged by the runner).
 *
 * Custom tools define their input schema with Zod. No dependency on any
 * specific agent SDK — the runner bridges tools to its own SDK.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Zod type utilities — defined locally so tools.ts has no SDK dependency
// ---------------------------------------------------------------------------

/**
 * A raw Zod object shape: `{ url: z.ZodString, count: z.ZodNumber }`.
 * Equivalent to the Claude Agent SDK's `AnyZodRawShape`.
 */
export type ZodShape = Record<string, z.ZodType>;

/**
 * Infer the output type from a raw Zod shape.
 *
 * ```ts
 * const schema = { url: z.string(), count: z.number().optional() };
 * type T = InferShape<typeof schema>; // { url: string; count?: number }
 * ```
 */
export type InferShape<T extends ZodShape> = z.output<z.ZodObject<T>>;

// ---------------------------------------------------------------------------
// Tool — the fundamental unit
// ---------------------------------------------------------------------------

export interface ToolContext {
  readonly agentId: string;
  readonly signal?: AbortSignal;
}

export interface ToolResult {
  readonly content: string;
  readonly isError?: boolean;
}

/**
 * A custom tool backed by a Zod schema. The `Schema` type parameter is the
 * raw Zod shape — the same shape most agent SDK tool helpers expect.
 */
export interface Tool<Schema extends ZodShape = ZodShape> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Schema;
  invoke(input: InferShape<Schema>, ctx: ToolContext): Promise<ToolResult>;
}

// ---------------------------------------------------------------------------
// Built-in marker — SDK-managed tools that pass through to the runner's SDK
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// ToolSource — a provider that resolves to one or more tools
// ---------------------------------------------------------------------------

export interface ToolSource {
  readonly id: string;
  resolve(): ResolvedTool[] | Promise<ResolvedTool[]>;
}

// ---------------------------------------------------------------------------
// ToolRegistry — maps string names to resolved tools
// ---------------------------------------------------------------------------

export class ToolRegistry {
  private readonly sources = new Map<string, ToolSource>();

  register(source: ToolSource): this {
    if (this.sources.has(source.id)) {
      throw new Error(`ToolSource "${source.id}" is already registered`);
    }
    this.sources.set(source.id, source);
    return this;
  }

  unregister(id: string): boolean {
    return this.sources.delete(id);
  }

  has(id: string): boolean {
    return this.sources.has(id);
  }

  sourceIds(): string[] {
    return [...this.sources.keys()];
  }

  /**
   * Resolve an agent's tool name list to ResolvedTool[].
   * Throws if any name is unknown.
   */
  async resolve(names: readonly string[]): Promise<ResolvedTool[]> {
    const allTools = new Map<string, ResolvedTool>();

    for (const source of this.sources.values()) {
      const tools = await source.resolve();
      for (const tool of tools) {
        allTools.set(tool.name, tool);
      }
    }

    const resolved: ResolvedTool[] = [];

    for (const name of names) {
      const tool = allTools.get(name);
      if (!tool) {
        const known = [...allTools.keys()].sort().join(", ");
        throw new Error(
          `Tool "${name}" not found in registry. Known tools: ${known}`,
        );
      }
      resolved.push(tool);
    }

    return resolved;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createRegistry(): ToolRegistry {
  return new ToolRegistry();
}
