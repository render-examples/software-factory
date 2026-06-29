// Response shapes mirrored from the gateway routes. Kept intentionally narrow —
// only the fields the operator UI reads.

export type RunStatus = "pending" | "running" | "paused" | "completed" | "failed" | "cancelled";
export type SpanKind = "workflow" | "agent" | "llm" | "tool" | "step";
export type SpanStatus = "running" | "ok" | "error";
export type EventCategory =
  | "lifecycle" | "message" | "tool" | "step" | "model" | "approval" | "delegation" | "context";

export interface RunRecord {
  id: string;
  workflow: string;
  status: RunStatus;
  input?: unknown;
  result?: unknown;
  error?: string;
  trigger?: string;
  totalCostUsd: number;
  threadId?: string;
  userId?: string;
  agentVersion?: string;
  startedAt: string;
  finishedAt?: string;
}

export interface RunDetail extends RunRecord {
  /** All-in cost incl. subagent descendants (server-aggregated). */
  aggregateCostUsd: number;
}

export interface SpanRecord {
  id: string;
  runId: string;
  parentId?: string;
  seq: number;
  name: string;
  kind: SpanKind;
  status: SpanStatus;
  input?: unknown;
  output?: unknown;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  attributes?: Record<string, unknown>;
}

export interface ToolCallEntry {
  seq: number;
  eventType: "tool.called" | "tool.result";
  payload: Record<string, unknown>;
}

export interface RunEventRecord {
  id: string;
  runId: string;
  seq: number;
  ts: string;
  category: EventCategory;
  type: string;
  agentName?: string;
  spanId?: string;
  parentSpanId?: string;
  payload: Record<string, unknown> & { type: string };
  version?: number;
}

export interface Approval {
  id: string;
  runId: string;
  toolName: string;
  input: unknown;
  agentName: string;
  status: "pending" | "approved" | "denied";
  requestedAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
  reason?: string;
}

export interface Thread {
  id: string;
  userId?: string;
  metadata?: Record<string, unknown>;
  currentRunId?: string;
  status: "active" | "idle" | "completed" | "failed" | "cancelled";
  title?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ThreadMessage {
  id: string;
  threadId: string;
  runId: string;
  seq: number;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface ScheduleRecord {
  id: string;
  workflow: string;
  cronExpression: string;
  input?: unknown;
  enabled: boolean;
  lastRunId?: string;
  lastRunAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** A decoded event from the global `/events/stream` (carries runId). */
export interface GlobalEvent {
  runId: string;
  seq: number;
  ts: string;
  category: EventCategory;
  type: string;
  agentName?: string;
  spanId?: string;
  parentSpanId?: string;
  payload: Record<string, unknown> & { type: string };
}
