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
