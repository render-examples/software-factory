import type { RunEvent, Message, Logger, Tracer, ContentBlock, ToolResult } from "@render-agents/store";
import type { MountedTools } from "./tool.js";
import type { AgentDefinition, AgentInput, AgentOutput } from "./agent.js";

export type ApprovalResult =
  | { approved: true }
  | { approved: false; reason?: string }
  | { status: "pending"; approvalRequestId: string };

export interface RunContext {
  readonly signal: AbortSignal;
  readonly logger: Logger;
  readonly tracer: Tracer;
  readonly runId: string;
  readonly parentSpanId?: string;
  readonly userId?: string;
  readonly depth: number;
  env(name: string): string | undefined;
  mountTools(toolIds: string[]): Promise<MountedTools>;
  requestApproval(toolName: string, input: unknown, toolCallId: string): Promise<ApprovalResult>;
  awaitInput(): Promise<ContentBlock[]>;
  emit(event: RunEvent): Promise<void>;
  messages(agentName: string): Promise<Message[]>;
  appliedToolResult(toolCallId: string): Promise<ToolResult | undefined>;
  isCancelled(): Promise<boolean>;
  /**
   * True when this run already has a `run.started` event in the log — i.e. this
   * is a resume/replay execution, not a fresh start. The runner uses this to
   * avoid re-emitting the initial `run.started`/`message.user` on resume.
   */
  hasStarted(): Promise<boolean>;
}

export interface AgentRunner {
  run(agent: AgentDefinition, input: AgentInput, ctx: RunContext): Promise<AgentOutput>;
}
