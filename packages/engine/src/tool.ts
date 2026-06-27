import type { Logger, ToolResult } from "@render-agents/store";

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
}

export interface ToolContext {
  env(name: string): string | undefined;
  readonly signal: AbortSignal;
  readonly logger: Logger;
  connection(provider: string): Promise<OAuthTokens | undefined>;
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

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
  close(): Promise<void>;
}

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
