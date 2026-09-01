export { Agent, agentTask, md, configure } from "./agent.js";
export type {
  AgentDef,
  AgentRunContext,
  AgentSpec,
  AgentTaskInput,
  AgentTaskOptions,
} from "./agent.js";

export {
  putBlob,
  getBlob,
  delBlob,
  isBlobRef,
  requireBlob,
  maybePutBlob,
  BLOB_THRESHOLD,
} from "./blobs.js";

export {
  ToolRegistry,
  createRegistry,
  isBuiltIn,
  isCustomTool,
} from "./tools.js";
export type {
  Tool,
  ToolSource,
  ToolContext,
  ToolResult,
  ResolvedTool,
  BuiltInTool,
  ZodShape,
  InferShape,
} from "./tools.js";

export type {
  AgentRunner,
  AgentEvent,
  RunContext,
  ToolCallEvent,
  ToolCallInterception,
  TokenUsage,
} from "./runner.js";

// Hooks
export { HookInterceptor } from "./hooks.js";
export type { Hook, HookResult, HookContext } from "./hooks.js";

// Model resolution
export {
  StaticModelResolver,
  createClaudeModelResolver,
  CLAUDE_TIERS,
} from "./models.js";
export type { ModelTier, ModelResolver, ResolvedModel, TierMap } from "./models.js";

export { ClaudeRunner, ClaudeBuiltInToolSource } from "./runners/index.js";

export {
  BaseSandbox,
  collectExecOutput,
  shellEscape,
} from "./sandbox/index.js";
export type {
  Sandbox,
  SandboxProvider,
  SandboxExecEvent,
  SandboxExecOptions,
  SandboxStatus,
  SandboxDownload,
  SandboxUploadData,
  SandboxUploadOptions,
  CreateSandboxOptions,
} from "./sandbox/index.js";

export { createSandboxToolSource } from "./sandbox-tool-source.js";
export type { SandboxToolSourceOptions } from "./sandbox-tool-source.js";

export { RenderSandboxProvider } from "./sandbox/index.js";
export type { RenderSandboxProviderOptions } from "./sandbox/index.js";
