/**
 * Tool system — custom tools, sources, and a registry.
 * Agents declare tools by name; the registry resolves them to built-in
 * (runner-native) or custom (Zod-schema) tools.
 */
import type { z } from "zod";

export type ZodShape = Record<string, z.ZodType>;

/** Infer the TS type from a raw Zod shape (e.g. `{ url: z.string() }`). */
export type InferShape<T extends ZodShape> = z.output<z.ZodObject<T>>;

export interface ToolContext {
  readonly agentId: string;
  readonly sandboxId?: string;
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

export interface ToolSource {
  readonly id: string;
  resolve(): ResolvedTool[] | Promise<ResolvedTool[]>;
}

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

  /** Resolve tool names to ResolvedTool[]. Throws on unknown names. */
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

export function createRegistry(): ToolRegistry {
  return new ToolRegistry();
}
