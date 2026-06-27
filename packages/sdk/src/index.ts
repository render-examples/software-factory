// @render-agents/sdk — Public API surface
// Re-exports all of engine + store + sdk-defined types

// --- Store (persistence/event vocabulary) ---
export type {
  EventCategory,
  ContentBlock,
  ToolResult,
  TokenUsage,
  RunEvent,
  RunEventRecord,
  EventLogStore,
  EventInterceptor,
  MessageRole,
  Message,
  Logger,
  SpanKind,
  SpanInfo,
  SpanOutcome,
  Tracer,
  SpanStatus,
  RunStatus,
  RunRecord,
  SpanRecord,
  ListRunsOptions,
  RunStore,
  CancelStore,
  ScheduleRecord,
  ScheduleStore,
  Thread,
  ThreadMessage,
  ThreadStore,
  ApprovalRequest,
  ApprovalStore,
  OAuthConnection,
  OAuthStore,
} from "@render-agents/store";
export { idempotencyKey } from "@render-agents/store";

// --- Engine (runtime vocabulary) ---
export type {
  RenderPlan,
  ModelSpec,
  ModelTier,
  SamplingParams,
  Budget,
  Permissions,
  ContextConfig,
  SkillMetadata,
  AgentDefinition,
  AgentInput,
  AgentOutput,
  PausedResult,
  AgentResult,
  RunOptions,
  TaskOptions,
  OAuthTokens,
  ToolContext,
  Tool,
  ToolSource,
  ResolvedSource,
  DefineToolSpec,
  DefineMcpSpec,
  Environment,
  MountedTools,
  ToolRegistry,
  SkillRegistry,
  ApprovalResult,
  RunContext,
  AgentRunner,
  ToolSchema,
  CompleteArgs,
  CompleteResult,
  ModelStreamEvent,
  ModelClient,
  RetryPolicy,
  ModelPricing,
  HookResult,
  HookContext,
  Hook,
  HookRegistry,
  ContextPrepareContext,
  ContextManager,
  CompactionStrategy,
  DelegationLimits,
  TierEntry,
  ResolveModelResult,
} from "@render-agents/engine";
export { RunPaused, MODEL_PRICING, estimateCost } from "@render-agents/engine";
export { resolveModelSpec, isTierAlias, inferProvider } from "@render-agents/engine";

// --- SDK-defined (composition/orchestration) ---
export type {
  RunnerRegistry,
  DispatchOptions,
  TaskDispatcher,
  AgentRuntime,
  CreateRuntimeOptions,
} from "./runtime.js";
export { createRuntime } from "./runtime.js";

export type { AgentSet, Agent } from "./agents.js";
export { loadAgents } from "./agents.js";

export type {
  WorkflowOptions,
  WorkflowContext,
  WorkflowDefinition,
  WebhookAdapter,
  WebhookMatch,
} from "./workflow.js";
export { workflow } from "./workflow.js";

export { defineTool, defineMcpSource, defineHook } from "./authoring.js";
