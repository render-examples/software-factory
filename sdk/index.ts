// Agent config and task bridge
export { Agent, agentTask, md, configure } from "./agent.js";
export type { AgentDef, AgentSpec, AgentTaskInput, AgentTaskOptions } from "./agent.js";

// Thread store
export { getThread, getOrCreateThread, appendMessage } from "./threads.js";
export type { Thread, ThreadMessage } from "./threads.js";

// Tool system (SDK-agnostic)
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

// Runner interface (SDK-agnostic)
export type { AgentRunner, AgentEvent, RunContext } from "./runner.js";

// Runner implementations
export { ClaudeRunner, ClaudeBuiltInToolSource } from "./runners/index.js";

// Sandbox system (SDK-agnostic interfaces)
export {
  BaseSandbox,
  collectExecOutput,
  shellEscape,
} from "./sandbox.js";
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
} from "./sandbox.js";

export { createSandboxToolSource } from "./sandbox-tool-source.js";
export type { SandboxToolSourceOptions } from "./sandbox-tool-source.js";

// Sandbox provider implementations
export { RenderSandboxProvider } from "./sandbox/index.js";
export type { RenderSandboxProviderOptions } from "./sandbox/index.js";
