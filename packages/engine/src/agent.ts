import type { TokenUsage } from "@render-agents/store";

export type RenderPlan =
  | "starter"
  | "standard"
  | "pro"
  | "pro_plus"
  | "pro_max"
  | "pro_ultra";

export interface ModelSpec {
  provider: "anthropic" | "openai";
  model: string;
  baseURL?: string;
  apiKeyEnv?: string;
}

export type ModelTier = "small" | "medium" | "large";

export interface SamplingParams {
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
}

export interface Budget {
  maxIterations?: number;
  maxTokens?: number;
  maxCostUsd?: number | null;
  maxWallSeconds?: number;
}

export interface Permissions {
  requireApproval?: string[];
}

export interface ContextConfig {
  compaction?: string;
  maxContextTokens?: number;
}

export interface SkillMetadata {
  id: string;
  name: string;
  description: string;
  whenToUse: string;
  content: string;
}

export interface AgentDefinition {
  name: string;
  description?: string;
  version?: string;
  model: ModelSpec;
  systemPrompt: string;
  tools: string[];
  subagents?: string[];
  skills?: SkillMetadata[];
  sampling?: SamplingParams;
  budget?: Budget;
  permissions?: Permissions;
  output?: Record<string, unknown>;
  context?: ContextConfig;
  plan?: RenderPlan;
  runner?: string;
  /**
   * Marks the agent as a *chat surface* (two-lane model, D12): the gateway
   * exposes it for interactive threads and the warm chat worker drives one run
   * per message turn. It does NOT change the agent loop — a turn completes
   * normally (turn-end is not a pause); multi-turn memory comes from the thread
   * transcript, and only HITL within a turn pauses.
   */
  interactive?: boolean;
}

export type AgentInput = string | Record<string, unknown>;

export interface AgentOutput<T = unknown> {
  text: string;
  data?: T;
  usage: TokenUsage;
}

export interface PausedResult {
  status: "paused";
  reason: "approval" | "input";
  pendingApprovalIds?: string[];
}

export type AgentResult<T = unknown> =
  | ({ status: "completed" } & AgentOutput<T>)
  | PausedResult;

export class RunPaused extends Error {
  readonly runId: string;
  readonly reason: "approval" | "input";
  readonly pendingApprovalIds?: string[];

  constructor(runId: string, reason: "approval" | "input", pendingApprovalIds?: string[]) {
    super(`Run ${runId} paused: ${reason}`);
    this.name = "RunPaused";
    this.runId = runId;
    this.reason = reason;
    this.pendingApprovalIds = pendingApprovalIds;
  }
}

export interface RunOptions {
  signal?: AbortSignal;
  runId?: string;
  parentSpanId?: string;
  /**
   * Tool-call ids to treat as pre-approved when resuming a paused run, bypassing
   * the approval gate for those calls. Approvals already recorded in the event
   * log are honored automatically and don't need to be listed here.
   */
  approvedToolCallIds?: ReadonlySet<string>;
}

export type TaskOptions = RunOptions;
