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
  JobQueue,
  JobRecord,
  JobKind,
  JobStatus,
  EnqueueOptions,
  FailOptions,
} from "@render-agents/store";
export { idempotencyKey, TERMINAL_STATUSES } from "@render-agents/store";
export { MemoryJobQueue, PgJobQueue, createJobQueue } from "@render-agents/store";

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
export { RunPaused, RunCancelled, MODEL_PRICING, estimateCost } from "@render-agents/engine";
export { resolveModelSpec, isTierAlias, inferProvider } from "@render-agents/engine";
export { defineTool as engineDefineTool, defineToolSource, ToolEnvironment, buildToolContext, ssrfFetch, validateToolInput } from "@render-agents/engine";

// --- SDK-defined (composition/orchestration) ---
export type {
  RunnerRegistry,
  DispatchOptions,
  TaskDispatcher,
  RootDispatchJob,
  AgentRuntime,
  CreateRuntimeOptions,
  ExecutionMode,
} from "./runtime.js";
export { createRuntime } from "./runtime.js";

export type { AgentSet, Agent } from "./agents.js";
export { loadAgents, resumeRun, driveAgentTurn } from "./agents.js";
export { loadWorkflows, loadWebhooks, loadToolSources, loadHooks, loadRunners } from "./loader/load-project.js";

export type {
  WorkflowOptions,
  WorkflowContext,
  WorkflowDefinition,
  WorkflowDispatchOptions,
  WebhookAdapter,
  WebhookMatch,
} from "./workflow.js";
export { workflow, bindWorkflow } from "./workflow.js";

export {
  InProcessDispatcher,
  RenderWorkflowsDispatcher,
  agentTaskHandler,
  workflowTaskHandler,
  computeDispatchKey,
  computeRequiredPlans,
  isWorkflowsEnvironment,
  isRootTriggerEnvironment,
} from "./dispatch.js";
export type { AgentTaskInput, InProcessDispatcherOptions } from "./dispatch.js";

export { defineTool, defineMcpSource, defineHook } from "./authoring.js";

export { runWorker, runWorkerLoop, buildJobProcessor } from "./worker.js";
export type { RunWorkerOptions, WorkerHandle, JobProcessor } from "./worker.js";

export { submitRootRun } from "./submit.js";
export type { SubmitRootRunOptions } from "./submit.js";
