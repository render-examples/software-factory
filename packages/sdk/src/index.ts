// @render-factory/sdk — Public API surface
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
  ChannelConversation,
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
export { ReplaySuspender, replaySuspender } from "@render-factory/engine";
export { resolveModelSpec, isTierAlias, inferProvider } from "@render-factory/engine";
export { defineTool as engineDefineTool, defineToolSource, ToolEnvironment, buildToolContext, ssrfFetch, validateToolInput } from "@render-factory/engine";

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
export { loadWorkflows, loadChannels, loadToolSources, loadHooks, loadRunners } from "./loader/load-project.js";

export { loadProject } from "./project.js";
export type { LoadProjectOptions, LoadedProject } from "./project.js";

export type {
  WorkflowOptions,
  WorkflowContext,
  WorkflowDefinition,
  WorkflowDispatchOptions,
} from "./workflow.js";
export { workflow, bindWorkflow } from "./workflow.js";

export type { Channel, ChannelInboundEvent, ChannelDeliverContext, ChannelTarget, ChannelMatch } from "./channel.js";

// Built-in reference channels (platform adapters authored on the Channel contract).
export { slackChannel } from "./channels/slack.js";
export type { SlackChannelOptions } from "./channels/slack.js";

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

export { NativeWorkflowsSuspender } from "./native-suspender.js";

export { defineTool, defineMcpSource, defineHook } from "./authoring.js";

export { deliverForRun } from "./channel-delivery.js";
