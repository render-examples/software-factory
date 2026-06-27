import type { ToolResult, Logger } from "@render-agents/store";
import type {
  Tool,
  ToolSource,
  ResolvedSource,
  DefineToolSpec,
  DefineMcpSpec,
  Environment,
  MountedTools,
  ToolContext,
  OAuthTokens,
} from "./tool.js";

/**
 * `defineTool` produces a single-tool source. The model-facing name is the
 * source id (set by the `tools/<dir>` convention key at load time). The tool
 * is the sole export of the source.
 *
 * For a **multi-tool source**, the `tools/<dir>/index.ts` should export an
 * *array* of `DefineToolSpec`s (or use `defineToolSource`); each becomes
 * `sourceId__toolName` in the model-facing namespace.
 */
export function defineTool(spec: DefineToolSpec): ToolSource {
  const tool: Tool = {
    name: spec.name,
    description: spec.description,
    inputSchema: spec.inputSchema,
    async invoke(input: unknown, ctx: ToolContext): Promise<ToolResult> {
      const raw = await spec.invoke(input, ctx);
      if (typeof raw === "string") return { content: raw };
      return raw;
    },
  };
  return {
    id: spec.name,
    async resolve(): Promise<ResolvedSource> {
      return { tools: [tool], close: async () => {} };
    },
  };
}

/**
 * Multi-tool source helper: given an array of specs, produces a single source
 * that resolves to multiple tools (model-facing names: `sourceId__toolName`).
 */
export function defineToolSource(id: string, specs: DefineToolSpec[]): ToolSource {
  return {
    id,
    async resolve(): Promise<ResolvedSource> {
      const tools: Tool[] = specs.map((spec) => ({
        name: `${id}__${spec.name}`,
        description: spec.description,
        inputSchema: spec.inputSchema,
        async invoke(input: unknown, ctx: ToolContext): Promise<ToolResult> {
          const raw = await spec.invoke(input, ctx);
          if (typeof raw === "string") return { content: raw };
          return raw;
        },
      }));
      return { tools, close: async () => {} };
    },
  };
}

/**
 * `defineMcpSource` produces an MCP-backed tool source. On `resolve`, it connects
 * to the MCP server (stdio or http), fetches the tool list, and exposes them as
 * `sourceId__toolName`.
 *
 * Wave 1 MVP: stdio/http connection via `@modelcontextprotocol/sdk` or a minimal
 * client. Until the MCP SDK is wired (a separate dep we defer), this returns a
 * stub that errors clearly at mount time.
 */
export function defineMcpSource(spec: DefineMcpSpec): ToolSource {
  const id = spec.name ?? "mcp";
  return {
    id,
    async resolve(_env: Environment): Promise<ResolvedSource> {
      // TODO(sprint-07): wire real MCP client transport (stdio/http).
      // For now, we provide the structure so the authoring contract works;
      // the actual MCP connection is a follow-up once the MCP SDK dep lands.
      throw new Error(
        `MCP source "${id}" cannot be mounted yet: MCP transport is not implemented. ` +
          `Use defineTool for local tools, or add MCP transport support.`,
      );
    },
  };
}

const RESERVED_TOOL_NAMES = new Set(["load_skill"]);

/**
 * The tool environment: resolves declared sources into a flat `MountedTools` map
 * and enforces model-facing name collisions + reserved names at mount time.
 * Disposal closes all resolved sources (MCP connections, etc.).
 */
export class ToolEnvironment {
  private sources: ResolvedSource[] = [];
  private disposed = false;

  async mount(
    sourceMap: Map<string, ToolSource>,
    declaredToolIds: string[],
    logger: Logger,
    signal: AbortSignal,
  ): Promise<MountedTools> {
    const env: Environment = {
      logger,
      signal,
      env: (name) => process.env[name],
      mount: async () => ({ tools: [], byName: () => undefined }),
      dispose: () => this.dispose(),
    };

    const allTools: Tool[] = [];
    const nameSet = new Set<string>();

    for (const declaredId of declaredToolIds) {
      const isNamespaced = declaredId.includes("__");
      const sourceId = isNamespaced ? declaredId.split("__")[0] : declaredId;
      const source = sourceMap.get(sourceId);

      if (!source) {
        logger.warn(`Tool source "${sourceId}" not found in registry; skipping`, { declaredId });
        continue;
      }

      const resolved = await source.resolve(env);
      this.sources.push(resolved);

      if (isNamespaced) {
        const toolName = declaredId;
        const tool = resolved.tools.find((t) => t.name === toolName || t.name === declaredId.split("__")[1]);
        if (tool) {
          const mountedName = toolName;
          this.checkCollision(mountedName, nameSet, declaredId);
          allTools.push({ ...tool, name: mountedName });
          nameSet.add(mountedName);
        } else {
          logger.warn(`Tool "${declaredId}" not found in source "${sourceId}"`, { declaredId });
        }
      } else {
        for (const tool of resolved.tools) {
          // If the source already produced namespaced names (e.g. defineToolSource),
          // use them as-is. Otherwise namespace as sourceId__toolName for multi-tool.
          const mountedName = resolved.tools.length > 1
            ? (tool.name.startsWith(`${sourceId}__`) ? tool.name : `${sourceId}__${tool.name}`)
            : sourceId;
          this.checkCollision(mountedName, nameSet, declaredId);
          allTools.push({ ...tool, name: mountedName });
          nameSet.add(mountedName);
        }
      }
    }

    return {
      tools: allTools,
      byName: (name: string) => allTools.find((t) => t.name === name),
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const source of this.sources) {
      await source.close().catch(() => {});
    }
    this.sources = [];
  }

  private checkCollision(name: string, existing: Set<string>, context: string): void {
    if (RESERVED_TOOL_NAMES.has(name)) {
      throw new Error(
        `Tool "${context}" resolves to reserved model-facing name "${name}"`,
      );
    }
    if (existing.has(name)) {
      throw new Error(
        `Model-facing tool name collision: "${name}" is already mounted (from "${context}")`,
      );
    }
  }
}

/**
 * Build a `ToolContext` from a `RunContext`-like shape (decoupled so the engine
 * doesn't import the full RunContext — only the fields a tool needs).
 */
export function buildToolContext(opts: {
  env: (name: string) => string | undefined;
  signal: AbortSignal;
  logger: Logger;
  userId?: string;
  ssrfFetch: (url: string, init?: RequestInit) => Promise<Response>;
}): ToolContext {
  return {
    env: opts.env,
    signal: opts.signal,
    logger: opts.logger,
    connection: async (_provider: string): Promise<OAuthTokens | undefined> => undefined,
    fetch: opts.ssrfFetch,
  };
}
