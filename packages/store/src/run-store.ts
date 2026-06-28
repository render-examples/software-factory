import type { EventLogStore, ToolResult } from "./events.js";
import type { Message } from "./messages.js";
import type { SpanKind, SpanStatus } from "./tracer.js";
import type { ApprovalProjectionRecord } from "./projections.js";

export interface ListApprovalsOptions {
  status?: "pending" | "approved" | "denied";
  limit?: number;
}

export type RunStatus = "pending" | "running" | "paused" | "completed" | "failed" | "cancelled";

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
  startedAt: string;
  finishedAt?: string;
  attributes?: Record<string, unknown>;
}

export interface ListRunsOptions {
  workflow?: string;
  status?: RunStatus;
  limit?: number;
  before?: string;
}

export interface RunStore {
  init(): Promise<void>;
  readonly events: EventLogStore;
  getRun(id: string): Promise<RunRecord | undefined>;
  listRuns(opts?: ListRunsOptions): Promise<RunRecord[]>;
  getMessages(runId: string, agentName: string): Promise<Message[]>;
  listSpans(runId: string): Promise<SpanRecord[]>;
  getStepResult(runId: string, name: string): Promise<{ value: unknown } | undefined>;
  getToolResult(runId: string, toolCallId: string): Promise<ToolResult | undefined>;
  /** Folded approval requests for a single run. */
  getApprovals(runId: string): Promise<ApprovalProjectionRecord[]>;
  /** Folded approval requests across all runs, optionally filtered by status. */
  listApprovals(opts?: ListApprovalsOptions): Promise<ApprovalProjectionRecord[]>;
  close(): Promise<void>;
}
