import type { Logger, ToolResult } from "@render-factory/store";

// --- Tool Context ---

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
}

export interface ToolContext {
  env(name: string): string | undefined;
  readonly signal: AbortSignal;
  readonly logger: Logger;
  /** The model-assigned id of the tool call being executed (for correlation). */
  readonly toolCallId?: string;
  /** The id of the run that invoked this tool (for store lookups). */
  readonly runId?: string;
  connection(provider: string): Promise<OAuthTokens | undefined>;
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

// --- Tool & Source ---

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  invoke(input: unknown, ctx: ToolContext): Promise<ToolResult>;
}

export interface ToolSource {
  readonly id: string;
  resolve(env: Environment): Promise<ResolvedSource>;
}

export interface ResolvedSource {
  readonly tools: Tool[];
  /**
   * When true, the environment always namespaces these tools as
   * `<sourceId>__<toolName>` at mount time, where `<sourceId>` is the convention
   * directory key the agent referenced — never collapsing a single tool to the
   * bare source id. MCP sources set this so their model-facing names track the
   * `tools/<dir>` folder (D6), independent of the server's advertised names.
   */
  readonly prefixTools?: boolean;
  close(): Promise<void>;
}

// --- Definition Specs ---

export interface DefineToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  invoke(input: unknown, ctx: ToolContext): Promise<ToolResult | string>;
}

export interface DefineMcpSpec {
  name?: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: () => Record<string, string>;
}

// --- Environment & Registries ---

export interface Environment {
  readonly logger: Logger;
  readonly signal: AbortSignal;
  env(name: string): string | undefined;
  mount(toolIds: string[]): Promise<MountedTools>;
  dispose(): Promise<void>;
}

export interface MountedTools {
  readonly tools: Tool[];
  byName(name: string): Tool | undefined;
}

export interface ToolRegistry {
  get(id: string): ToolSource;
  has(id: string): boolean;
  ids(): string[];
}

export interface SkillRegistry {
  get(id: string): import("./agent.js").SkillMetadata;
  has(id: string): boolean;
  ids(): string[];
}
