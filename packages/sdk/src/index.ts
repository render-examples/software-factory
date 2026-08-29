// @render-factory/sdk — Public API surface

// --- Store (persistence/event vocabulary) ---
export type {
  EventCategory,
  ContentBlock,
  ToolResult,
  TokenUsage,
  RunEvent,
  RunEventRecord,
  EventQueryOptions,
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
  ListChildRunsOptions,
  RunStore,
  CancelStore,
  ScheduleRecord,
  ScheduleStore,
  Thread,
  ThreadMessage,
  ThreadStore,
  ThreadSurface,
  ThreadSurfaceStore,
  ThreadItem,
  AppendItemInput,
  ThreadItemQueryOptions,
  ThreadItemStore,
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
} from "@render-factory/store";
export { idempotencyKey, TERMINAL_STATUSES } from "@render-factory/store";
export { MemoryJobQueue, PgJobQueue, createJobQueue } from "@render-factory/store";

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
  InputResult,
  RunContext,
  AgentRunner,
  Suspender,
  SuspendRequest,
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
} from "@render-factory/engine";
export { RunPaused, RunCancelled, MODEL_PRICING, estimateCost } from "@render-factory/engine";
export { resolveModelSpec } from "@render-factory/engine";
export { defineToolSource } from "@render-factory/engine";

// --- SDK composition / orchestration ---
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
export { resumeRun, driveAgentTurn } from "./agents.js";

// Internal workflow runtime (used by boot, dispatch, and gateway tests)
export type { WorkflowDefinition, WorkflowContext, WorkflowOptions, WorkflowDispatchOptions } from "./workflow.js";
export { workflow, bindWorkflow } from "./workflow.js";

// --- Channels & webhook verification ---
export type { Channel, ChannelInboundEvent, ChannelDeliverContext, ChannelTarget, ChannelMatch } from "./channel.js";

export type {
  WebhookVerify,
  HmacVerify,
  GitHubVerify,
  SlackVerify,
  StripeVerify,
  StandardWebhooksVerify,
  NoVerify,
  SignatureEncoding,
  HmacAlgorithm,
} from "./webhook-verify.js";
export {
  hmacVerify,
  githubVerify,
  slackVerify,
  stripeVerify,
  standardWebhooksVerify,
} from "./webhook-verify.js";

// --- Dispatch ---
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

// --- Typed authoring API ---
export {
  md,
  defineAgent,
  defineTool,
  defineWorkflow,
  defineChannel,
  defineFactory,
  defineMcpSource,
  matchesRepoAllowlist,
  isAgentDef,
  isWorkflowDef,
  isChannelDef,
  isFactoryDef,
} from "./define.js";
export type {
  AgentDef,
  AgentDefinitionSpec,
  ToolSetupContext,
  TypedToolSpec,
  TypedToolWithSetup,
  ToolDef,
  WorkflowDef,
  WorkflowDefinitionSpec,
  WorkflowTaskContext,
  TaskResult,
  ChannelDef,
  ChannelDefSpec,
  ChannelTargetDef,
  FactoryDef,
  FactorySpec,
} from "./define.js";

// --- Factory boot ---
export { bootFactory } from "./boot.js";
export type { BootedFactory, BootFactoryOverrides } from "./boot.js";

// --- Thread surface notifications ---
export { notifyThreadSurfaces } from "./notify-surfaces.js";
