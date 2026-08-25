export type EventCategory =
  | "lifecycle"
  | "message"
  | "tool"
  | "step"
  | "model"
  | "input"
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
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export type RunEvent =
  // lifecycle
  | { type: "run.started"; trigger?: string; input?: unknown; agentVersion?: string; threadId?: string; userId?: string; model?: string; spanKind?: "agent" | "workflow"; channel?: string; externalConversationId?: string }
  | { type: "run.completed"; result?: unknown }
  | { type: "run.failed"; error: string }
  | { type: "run.paused"; reason: "input"; pendingInputIds?: string[] }
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
  // input
  | { type: "input.requested"; inputRequestId: string; kind: "approval" | "message"; toolName?: string; input?: unknown; prompt?: string }
  | { type: "input.provided"; inputRequestId: string; kind: "approval" | "message"; approved?: boolean; value?: unknown; providedBy?: string; reason?: string }
  | { type: "input.auto"; kind: "approval" | "message"; toolName?: string }
  // channel: idempotency guard for redelivery. inputRequestId present → HITL prompt; absent → final reply.
  | { type: "channel.delivered"; channel: string; externalConversationId?: string; inputRequestId?: string }
  // delegation
  | { type: "subagent.spawned"; agentName: string; childRunId: string; toolCallId: string }
  // context
  | { type: "context.compacted"; agentName: string; strategy: string; beforeTokens: number; afterTokens: number };

/**
 * Event types that are **transient** (D13): part of the SSE `RunEvent` taxonomy
 * clients subscribe to, but never persisted to `run_events`, never folded into a
 * projection, and never retained. They travel over the out-of-band `DeltaBus`
 * (Postgres `NOTIFY` / in-process), not `events.append`. The append path rejects
 * them as a guard against accidental persistence.
 */
export const TRANSIENT_EVENT_TYPES: ReadonlySet<RunEvent["type"]> = new Set(["text.delta"]);

export function isTransientEvent(type: RunEvent["type"]): boolean {
  return TRANSIENT_EVENT_TYPES.has(type);
}

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
  /** References to externally stored artifacts (used for payloads exceeding 8KB). */
  artifactRefs?: Record<string, string>;
  /** Event classification tag (e.g. "tool_call", "message", "internal"). */
  classification?: string;
  /** Correlation ID for tracing a causal chain across runs. */
  correlationId?: string;
  /** Causation ID linking this event to the event that caused it. */
  causationId?: string;
  /** Client-supplied idempotency key — unique per tenant where present. */
  idempotencyKey?: string;
}

export interface EventLogStore {
  append(event: RunEventRecord): Promise<void>;
  read(runId: string, fromSeq?: number): Promise<RunEventRecord[]>;
  /**
   * Durable events across every run belonging to a thread, in a single canonical
   * order (`ts`, then `runId`, then `seq`). Powers SSE catch-up replay for the
   * thread stream, where per-run `seq` alone is ambiguous (each run restarts at
   * 1). Clients de-dupe on the composite `runId:seq` cursor.
   */
  readThread(threadId: string): Promise<RunEventRecord[]>;
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
