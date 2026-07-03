import type { EventLogStore, ToolResult } from "./events.js";
import type { Message } from "./messages.js";
import type { SpanKind, SpanStatus } from "./tracer.js";
import type { InputRequestProjectionRecord } from "./projections.js";

export interface ListInputsOptions {
  status?: "pending" | "approved" | "denied" | "provided";
  kind?: "approval" | "message";
  limit?: number;
}

/** Two-domain retention horizons (see Operations → Retention). */
export interface RetentionOptions {
  /** Event-detail horizon (run_events + detail projections). */
  eventRetentionDays: number;
  /** Run-summary horizon (the `runs` table). Should be >= eventRetentionDays. */
  runRetentionDays: number;
  /** Clock injection for tests. Defaults to now. */
  now?: Date;
}

export interface RetentionResult {
  /** Terminal runs whose event-detail was trimmed (events + detail projections). */
  eventDetailTrimmed: number;
  /** Terminal run summaries deleted. */
  runsDeleted: number;
}

/** Options for the stranded-run reaper (E6). */
export interface ReapOptions {
  /**
   * A non-terminal run whose most recent event is older than this is considered
   * stranded (the workflow host accepted the hand-off but never progressed it).
   */
  staleMs: number;
  /** Clock injection for tests. Defaults to now. */
  now?: Date;
}

export interface ReapResult {
  /** Number of stranded runs transitioned to `failed`. */
  reaped: number;
  /** The ids that were reaped (handy for tests/observability). */
  runIds: string[];
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
  /**
   * Span this run hangs off in its parent run, when spawned by another run
   * (workflow `.task()`/`.run()` fan-out, or an LLM subagent). Undefined for
   * top-level roots. Lets the UI hide child runs from the top-level list and
   * stitch them into the parent's trace.
   */
  parentSpanId?: string;
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
  threadId?: string;
  /** Scope to a single owner (tenant). Omit for all users (operator view). */
  userId?: string;
  limit?: number;
  before?: string;
  /** When true, return only top-level roots (runs with no `parentSpanId`). */
  roots?: boolean;
}

export interface RunStore {
  init(): Promise<void>;
  readonly events: EventLogStore;
  getRun(id: string): Promise<RunRecord | undefined>;
  listRuns(opts?: ListRunsOptions): Promise<RunRecord[]>;
  /**
   * Child runs spawned by `runId` — runs whose `parentSpanId` points at a span
   * within `runId` (workflow `.task()`/`.run()` fan-out or LLM subagents),
   * oldest first. Used to stitch the parent's trace across runs.
   */
  listChildRuns(runId: string): Promise<RunRecord[]>;
  getMessages(runId: string, agentName: string): Promise<Message[]>;
  /**
   * Model-visible history folded across *every run sharing a thread* (ordered by
   * run start, then seq), for the chat lane's new-run-per-turn model: a chat turn
   * is its own run, but multi-turn memory comes from the thread transcript rather
   * than one ever-growing parked run. Optional — stores that don't implement it
   * fall back to run-scoped `getMessages` (single-turn memory).
   */
  getThreadAgentMessages?(threadId: string, agentName: string): Promise<Message[]>;
  listSpans(runId: string): Promise<SpanRecord[]>;
  getStepResult(runId: string, name: string): Promise<{ value: unknown } | undefined>;
  getToolResult(runId: string, toolCallId: string): Promise<ToolResult | undefined>;
  /** Folded input requests for a single run. */
  getInputs(runId: string): Promise<InputRequestProjectionRecord[]>;
  /** Folded input requests across all runs, optionally filtered by status/kind. */
  listInputs(opts?: ListInputsOptions): Promise<InputRequestProjectionRecord[]>;
  /**
   * Two-domain retention cleanup. Trims event-detail (run_events + detail
   * projections) for terminal runs older than the event horizon, and deletes
   * run summaries older than the run horizon. Never touches non-terminal runs,
   * thread metadata/transcript, or schedules.
   */
  cleanup(opts: RetentionOptions): Promise<RetentionResult>;
  /**
   * Fail Lane A roots stranded in a non-terminal state (E6). Targets runs in
   * `pending`/`running` that have **no active queue job** (Lane B runs are
   * reclaimed by the job queue's own reaper, not failed here) and whose most
   * recent event is older than `staleMs`. Appends `run.failed` so the run is
   * terminal and the log stays canonical. Never touches `paused` or terminal
   * runs. Idempotent.
   */
  reapStaleRuns(opts: ReapOptions): Promise<ReapResult>;
  close(): Promise<void>;
}

/** Terminal run statuses — only these are eligible for retention trimming. */
export const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>(["completed", "failed", "cancelled"]);
