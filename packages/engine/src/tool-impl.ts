import type { ToolResult, Logger } from "@render-factory/store";
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
import { connectMcp } from "./mcp-client.js";

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
 * to the MCP server (stdio or http), performs the initialize handshake, fetches
 * the tool list, and exposes each as `sourceId__toolName`. Tool invocations are
 * proxied over JSON-RPC `tools/call`; `close()` tears down the connection.
 */
export function defineMcpSource(spec: DefineMcpSpec): ToolSource {
  // The source `id` is only a fallback for the rare direct (non-loader) use; the
  // model-facing namespace comes from the `tools/<dir>` key at mount time via
  // `prefixTools` (BUG-10). Tools are emitted with their bare server names so the
  // environment can namespace them by the directory the agent referenced.
  const id = spec.name ?? "mcp";
  return {
    id,
    async resolve(_env: Environment): Promise<ResolvedSource> {
      const connection = await connectMcp(spec);
      let descriptors;
      try {
        descriptors = await connection.listTools();
      } catch (err) {
        await connection.close().catch(() => {});
        throw err;
      }

      const tools: Tool[] = descriptors.map((d) => ({
        name: d.name,
        description: d.description ?? `MCP tool ${d.name}`,
        inputSchema: d.inputSchema ?? { type: "object" },
        async invoke(input: unknown): Promise<ToolResult> {
          const result = await connection.callTool(d.name, input);
          return { content: result.content, isError: result.isError };
        },
      }));

      return { tools, prefixTools: true, close: () => connection.close() };
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
    const resolvedBySourceId = new Map<string, ResolvedSource>();

    for (const declaredId of declaredToolIds) {
      const isNamespaced = declaredId.includes("__");
      const sourceId = isNamespaced ? declaredId.split("__")[0] : declaredId;
      const source = sourceMap.get(sourceId);

      if (!source) {
        logger.warn(`Tool source "${sourceId}" not found in registry; skipping`, { declaredId });
        continue;
      }

      let resolved = resolvedBySourceId.get(sourceId);
      if (!resolved) {
        resolved = await source.resolve(env);
        resolvedBySourceId.set(sourceId, resolved);
        this.sources.push(resolved);
      }

      if (isNamespaced) {
        const bareName = declaredId.split("__")[1];
        const tool = resolved.tools.find((t) => t.name === declaredId || t.name === bareName);
        if (tool) {
          const mountedName = declaredId;
          this.checkCollision(mountedName, nameSet, declaredId);
          allTools.push({ ...tool, name: mountedName });
          nameSet.add(mountedName);
        } else {
          logger.warn(`Tool "${declaredId}" not found in source "${sourceId}"`, { declaredId });
        }
      } else {
        for (const tool of resolved.tools) {
          // Model-facing naming:
          // - `prefixTools` sources (MCP) always namespace as sourceId__toolName,
          //   keyed on the directory the agent referenced (D6) — no single-tool
          //   collapse (BUG-10).
          // - defineToolSource already produced sourceId__name; keep as-is.
          // - a lone tool (defineTool) collapses to the bare source id.
          const mountedName = resolved.prefixTools
            ? `${sourceId}__${tool.name}`
            : resolved.tools.length > 1
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
  runId?: string;
  ssrfFetch: (url: string, init?: RequestInit) => Promise<Response>;
}): ToolContext {
  return {
    env: opts.env,
    signal: opts.signal,
    logger: opts.logger,
    runId: opts.runId,
    connection: async (_provider: string): Promise<OAuthTokens | undefined> => undefined,
    fetch: opts.ssrfFetch,
  };
}
