export type EventCategory =
  | "lifecycle"
  | "message"
  | "tool"
  | "step"
  | "model"
  | "approval"
  | "delegation"
  | "context";

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; content: string; isError?: boolean };

export interface ToolResult {
  content: string;
  isError?: boolean;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export type RunEvent =
  // lifecycle
  | { type: "run.started"; trigger?: string; input?: unknown }
  | { type: "run.completed"; result?: unknown }
  | { type: "run.failed"; error: string }
  | { type: "run.paused"; reason: "approval" | "input"; pendingApprovalIds?: string[] }
  | { type: "run.cancelled" }
  // message
  | { type: "message.user"; content: ContentBlock[] }
  | { type: "message.assistant"; agentName: string; content: ContentBlock[] }
  | { type: "message.tool"; agentName: string; content: ContentBlock[] }
  | { type: "text.delta"; agentName: string; text: string }
  // tool
  | { type: "tool.called"; toolCallId: string; name: string; input: unknown }
  | { type: "tool.result"; toolCallId: string; name: string; result: ToolResult }
  // step
  | { type: "step.started"; name: string }
  | { type: "step.completed"; name: string; result: unknown }
  // model
  | { type: "llm.call"; model: string; usage: TokenUsage; costUsd: number; stopReason: string; latencyMs: number }
  // approval
  | { type: "approval.requested"; approvalRequestId: string; toolName: string; input: unknown }
  | { type: "approval.resolved"; approvalRequestId: string; approved: boolean; resolvedBy?: string; reason?: string }
  | { type: "approval.auto"; toolName: string }
  // delegation
  | { type: "subagent.spawned"; agentName: string; childRunId: string; toolCallId: string }
  // context
  | { type: "context.compacted"; agentName: string; strategy: string; beforeTokens: number; afterTokens: number };

export interface RunEventRecord {
  id: string;
  runId: string;
  seq: number;
  ts: string;
  category: EventCategory;
  type: RunEvent["type"];
  agentName?: string;
  spanId?: string;
  parentSpanId?: string;
  payload: RunEvent;
  version: number;
}

export interface EventLogStore {
  append(event: RunEventRecord): Promise<void>;
  read(runId: string, fromSeq?: number): Promise<RunEventRecord[]>;
  tail(filter: { runId?: string; threadId?: string }, signal: AbortSignal): AsyncIterable<RunEventRecord>;
}

export interface EventInterceptor {
  intercept(
    event: RunEvent,
    meta: { runId: string; agentName?: string },
  ): Promise<
    | { action: "continue"; event?: RunEvent }
    | { action: "reject"; reason: string }
  >;
}
