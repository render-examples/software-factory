# Type Reference

**Status:** DRAFT
**Date:** 2026-06-25

**Layer:** L5 — *exact shapes.* Part of the [render-agents specification](00-foundations.md) ([Document Map](00-foundations.md#document-map)).

Every public `interface`/`type` in one place, grouped by package. Narrative and examples live in the layer files that link here.

> **Grouping denotes public-surface ownership, not physical module location.** Headers like "Core (@render-agents/sdk)" mean "exported as part of that package's public API" — which `sdk` achieves largely by **re-export**. To keep the dependency graph acyclic (`engine`/`store` must not import from `sdk`; see [Architecture at a Glance](00-foundations.md#architecture-at-a-glance)), the shared vocabulary is physically defined lower: the **persistence/event vocabulary** (`RunEvent`/`RunEventRecord`/`EventCategory`, `EventLogStore`, `EventInterceptor`, `Message`/`ContentBlock`/`MessageRole`, `ToolResult`, `TokenUsage`, `Logger`) lives in `@render-agents/store`, and the **runtime vocabulary** (`RunContext`, `AgentRunner`, `AgentDefinition`, `Tool`/`ToolContext`, `AgentInput`/`AgentOutput`, `MountedTools`, `ContextManager`, the `Hook*` authoring contract, …) lives in `@render-agents/engine`. The append path runs hooks via the `EventInterceptor` seam (engine adapts `Hook` → `EventInterceptor`); `store` never imports the `Hook` type. The **operational persistence interfaces** under the Gateway grouping (`ThreadStore`/`ApprovalStore`/`OAuthStore` and their record types `Thread`/`ThreadMessage`/`ApprovalRequest`/`OAuthConnection`) are likewise physically defined in `@render-agents/store` — `store` owns all persistence — while only the HTTP-facing `ConnectorSpec`/`ConnectorContext` are physically in `gateway`. Both layers are re-exported by `sdk`.

---

## Core (@render-agents/sdk)

### AgentDefinition
The parsed, validated, resolved form of an agent markdown file.

```ts
interface AgentDefinition {
  name: string;
  /** Short description of the agent's purpose. Used as the tool description when this agent is exposed as a subagent. Falls back to `name` if absent. */
  description?: string;
  /** Author-declared version string. Metadata only — no selection/resolution logic. Recorded on agent spans and run records for audit/repro ("which version produced this?"). */
  version?: string;
  model: ModelSpec;
  systemPrompt: string;
  tools: string[];
  /** Agents this agent may spawn as subagents (resolved against the AgentSet). Exposed to the model as `subagents__<name>` tools. */
  subagents?: string[];
  skills?: SkillMetadata[];
  sampling?: SamplingParams;
  budget?: Budget;
  permissions?: Permissions;
  /** Optional JSON Schema for structured output. When set, the runner returns validated `AgentOutput.data`. */
  output?: Record<string, unknown>;
  /** Context-management / compaction settings. Defaults to auto-compaction sized to the model's window. */
  context?: ContextConfig;
  plan?: RenderPlan;
  runner?: string;
  /**
   * Marks the agent as a *chat surface* (two-lane model, D12): the gateway exposes
   * it for interactive threads and the warm chat worker drives one run per message
   * turn. It does NOT change the agent loop — a turn completes normally (turn-end is
   * not a pause); multi-turn memory comes from thread-scoped history across the
   * thread's runs, and only within-turn HITL pauses. Default false (autonomous:
   * a workflow root that drives to completion).
   */
  interactive?: boolean;
}
```

### ContextConfig
Per-agent context-management settings. Controls how the model-visible window is compacted as a run grows.

```ts
interface ContextConfig {
  /** Compaction strategy name (built-in or registered). Default "auto". Set "none" to disable. */
  compaction?: string;
  /** Token threshold that triggers compaction. Default: derived from the model's context window (e.g. ~75%). */
  maxContextTokens?: number;
}
```

### Permissions
Per-agent permission block; the resolved tool names that require HITL approval.

```ts
interface Permissions {
  /** Resolved tool names that require HITL approval before execution. */
  requireApproval?: string[];
}
```

### RenderPlan
Render Workflows instance type for a task run.

```ts
/**
 * Render Workflows instance type for a task run — Render's `plan` task option.
 * Values mirror Render's instance-type slugs; `standard` (1 CPU / 2 GB) is the
 * default. `pro_plus` / `pro_max` / `pro_ultra` require requesting workspace
 * access. Compute is bound to the task at definition/registration time: there
 * is no arbitrary cpu/memory, and the run-trigger API (startTask / REST) takes
 * only task + input — no per-run override. This is why one dispatch task is
 * registered per referenced plan.
 */
type RenderPlan =
  | "starter"
  | "standard"
  | "pro"
  // The following require requesting workspace access:
  | "pro_plus"
  | "pro_max"
  | "pro_ultra";
```

### AgentInput
The input accepted by `agent.run()` / `agent.task()`.

```ts
type AgentInput = string | Record<string, unknown>;
```

### AgentOutput
The completed result of an agent invocation.

```ts
interface AgentOutput<T = unknown> {
  text: string;
  /** Validated structured output. Present only when the agent declares an `output` schema. */
  data?: T;
  usage: TokenUsage;
}
```

### AgentResult
An agent invocation inspected at a runtime boundary (completed or paused).

```ts
/**
 * Result of an agent invocation when inspected at a runtime boundary.
 * The happy path of `run()`/`task()` resolves to `AgentOutput` (completed).
 * On HITL pause, the runner throws `RunPaused` (control-flow signal); the
 * runtime catch boundary can surface a `PausedResult` for callers that inspect.
 */
type AgentResult<T = unknown> =
  | ({ status: "completed" } & AgentOutput<T>)
  | PausedResult;
```

### PausedResult
The paused-boundary view of an agent invocation.

```ts
interface PausedResult {
  status: "paused";
  reason: "approval" | "input";
  /** Set when `reason === "approval"`. */
  pendingApprovalIds?: string[];
}
```

### RunPaused
The control-flow signal thrown by the runner on HITL pause.

```ts
/** Thrown by the runner to unwind execution on pause (HITL approval or awaiting input). Caught by the workflow/gateway runtime, which marks the run "paused". */
declare class RunPaused extends Error {
  readonly runId: string;
  readonly reason: "approval" | "input";
  /** Set when `reason === "approval"`. */
  readonly pendingApprovalIds?: string[];
}
```

### AgentSet
The collection of agents returned by `loadAgents()`.

```ts
interface AgentSet {
  get(id: string): Agent;
  get(ids: string[]): Agent[];
  has(id: string): boolean;
  all(): Agent[];
}
```

### Agent
A runtime-bound agent handle.

```ts
interface Agent {
  readonly name: string;
  readonly definition: AgentDefinition;
  /** `T` is the type of `AgentOutput.data` when the agent declares an `output` schema. */
  run<T = unknown>(input: AgentInput, opts?: RunOptions): Promise<AgentOutput<T>>;
  task<T = unknown>(input: AgentInput, opts?: TaskOptions): Promise<AgentOutput<T>>;
}
```

### RunOptions
Options for an in-process `agent.run()`.

```ts
interface RunOptions {
  signal?: AbortSignal;
  runId?: string;
  parentSpanId?: string;
  /** Tool-call ids to treat as pre-approved when resuming a paused run, bypassing the approval gate. Approvals already in the log are honored automatically. */
  approvedToolCallIds?: ReadonlySet<string>;
}
```

### TaskOptions
Options for a dispatched `agent.task()`.

```ts
/**
 * Options for `agent.task()`. Compute is NOT overridable per dispatch — the
 * effective plan comes from the agent's frontmatter `plan` (or the default).
 */
type TaskOptions = RunOptions;
```

### ModelSpec
A concrete model selection.

```ts
interface ModelSpec {
  provider: "anthropic" | "openai";
  model: string;
  baseURL?: string;
  apiKeyEnv?: string;
}
```

### ModelTier
The tier aliases that resolve to concrete models.

```ts
type ModelTier = "small" | "medium" | "large";
```

### SamplingParams
Optional model sampling overrides.

```ts
interface SamplingParams {
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
}
```

### TokenUsage
Input/output token counts for a model call.

```ts
interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}
```

### Budget
Per-agent-invocation resource ceilings.

```ts
interface Budget {
  maxIterations?: number;
  maxTokens?: number;
  /** USD ceiling per agent invocation. Default 10; null or 0 disables it. */
  maxCostUsd?: number | null;
  maxWallSeconds?: number;
}
```

### ContentBlock
A single block within a message.

```ts
type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; content: string; isError?: boolean };
```

### MessageRole
The role of a message in the loop.

```ts
type MessageRole = "user" | "assistant" | "tool";
```

### Message
A single LLM message.

```ts
interface Message {
  role: MessageRole;
  content: ContentBlock[];
}
```

### Tool
A single model-callable capability.

```ts
interface Tool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  invoke(input: unknown, ctx: ToolContext): Promise<ToolResult>;
}
```

### ToolResult
The result of a tool invocation.

```ts
interface ToolResult {
  content: string;
  isError?: boolean;
}
```

### ToolContext
The context passed to a tool's `invoke`.

```ts
interface ToolContext {
  env(name: string): string | undefined;
  readonly signal: AbortSignal;
  readonly logger: Logger;
  /** The model-assigned id of the tool call being executed (for correlation). */
  readonly toolCallId?: string;
  /**
   * Per-user OAuth connection for the given provider, resolved via the run's
   * `userId` against the OAuthStore. Returns undefined when there is no user
   * (system/cron runs) or no stored connection — OAuth-dependent tools should
   * return a clear error result in that case rather than throwing.
   */
  connection(provider: string): Promise<OAuthTokens | undefined>;
  /** SSRF-guarded fetch. Blocks private IPs, internal ranges, and metadata endpoints. */
  fetch(url: string, init?: RequestInit): Promise<Response>;
}
```

### OAuthTokens
The per-user OAuth tokens surfaced to a tool.

```ts
interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
}
```

### ToolSource
A tool directory: provides one or many tools.

```ts
interface ToolSource {
  readonly id: string;
  resolve(env: Environment): Promise<ResolvedSource>;
}
```

### ResolvedSource
A mounted tool source with a disposal hook.

```ts
interface ResolvedSource {
  readonly tools: Tool[];
  close(): Promise<void>;
}
```

### DefineToolSpec
The spec passed to `defineTool`.

```ts
interface DefineToolSpec {
  /** Tool name within the source. Required for multi-tool sources. */
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  invoke(input: unknown, ctx: ToolContext): Promise<ToolResult | string>;
}
```

### defineTool
Authoring helper for a local tool source.

```ts
function defineTool(spec: DefineToolSpec): ToolSource;
```

### DefineMcpSpec
The spec passed to `defineMcpSource`.

```ts
interface DefineMcpSpec {
  name?: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: () => Record<string, string>;
}
```

### defineMcpSource
Authoring helper for an MCP-backed tool source.

```ts
function defineMcpSource(spec: DefineMcpSpec): ToolSource;
```

### SkillMetadata
On-demand instruction content advertised to the model.

```ts
interface SkillMetadata {
  id: string;
  name: string;
  description: string;
  whenToUse: string;
  content: string;
}
```

### SkillRegistry
The discovered set of skills.

```ts
interface SkillRegistry {
  get(id: string): SkillMetadata;
  has(id: string): boolean;
  ids(): string[];
}
```

### Environment
The tool-mounting environment passed to a source's `resolve`.

```ts
interface Environment {
  readonly logger: Logger;
  readonly signal: AbortSignal;
  env(name: string): string | undefined;
  mount(toolIds: string[]): Promise<MountedTools>;
  dispose(): Promise<void>;
}
```

### MountedTools
The set of mounted tools, looked up by model-facing name.

```ts
interface MountedTools {
  readonly tools: Tool[];
  byName(name: string): Tool | undefined;
}
```

### Logger
Structured logger injected into tool, environment, run, workflow, and connector contexts.

```ts
interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}
```

### ToolRegistry
The discovered set of tool sources.

```ts
interface ToolRegistry {
  get(id: string): ToolSource;
  has(id: string): boolean;
  ids(): string[];
}
```

### AgentRunner
The pluggable agent-loop interface.

```ts
interface AgentRunner {
  run(agent: AgentDefinition, input: AgentInput, ctx: RunContext): Promise<AgentOutput>;
}
```

### RunContext
The full platform contract a runner interacts with.

```ts
interface RunContext {
  readonly signal: AbortSignal;
  readonly logger: Logger;
  readonly tracer: Tracer;
  readonly runId: string;
  readonly parentSpanId?: string;
  /** The user this run belongs to (from the gateway's auth). Undefined for system/cron runs. Used to resolve per-user OAuth in ToolContext. */
  readonly userId?: string;
  /** Delegation depth: 0 for a root run, +1 per subagent level. Used to enforce maxDepth. */
  readonly depth: number;
  env(name: string): string | undefined;

  /**
   * Resolve the current user's OAuth tokens for a provider (decrypted, and
   * refreshed if expired). Returns undefined when no store/user/connection is
   * available. Surfaced to tools via `ToolContext.connection()`.
   */
  connection(provider: string): Promise<OAuthTokens | undefined>;

  mountTools(toolIds: string[]): Promise<MountedTools>;

  /**
   * HITL gate. Production (gateway) records an `approval.requested` event and
   * returns `{ status: "pending" }`; in-process behavior follows the approval
   * mode. It does NOT block. `toolCallId` correlates the gate with the tool call.
   */
  requestApproval(toolName: string, input: unknown, toolCallId: string): Promise<ApprovalResult>;

  /**
   * Within-turn input pause (sibling of `requestApproval`). A tool calls this when
   * the current turn needs a typed human reply before it can continue. Production
   * emits `run.paused { reason: "input" }` and unwinds via `RunPaused`; the run
   * resumes when `/runs/:id/input` delivers the reply (appended as a `message.user`
   * event), and on resume this returns that content. NOTE (D12): this is NOT how
   * chat turn-taking works — under the two-lane model each chat message is its own
   * short run that completes, so turn boundaries are not pauses. `awaitInput()` is
   * only for mid-turn human input.
   */
  awaitInput(): Promise<ContentBlock[]>;

  /**
   * The single write path. Appends an event to the run's event log; the
   * store fans it out to projections (messages, spans, tool-calls, cost),
   * NOTIFYs the SSE stream, and feeds it through hooks. Runtime code never
   * writes a projection directly — it only emits events. Cost/usage are carried
   * on `llm.call` events; budget accounting folds over them.
   */
  emit(event: RunEvent): Promise<void>;

  /**
   * Publish a transient token delta for live streaming (D13). Fire-and-forget
   * and non-durable: it rides the out-of-band `DeltaBus` (Postgres NOTIFY /
   * in-process), NEVER the event log, and is a no-op when no bus is wired. The
   * runner calls this with coalesced text as the model streams; the canonical
   * turn output is still the durable `message.assistant` emitted once via `emit`.
   */
  streamDelta(text: string): void;

  /**
   * The model-visible message history for `agentName`, folded from the event
   * log and passed through context management/compaction. Returns [] for
   * a fresh run; on resume it reconstructs exactly where the loop left off.
   */
  messages(agentName: string): Promise<Message[]>;

  /**
   * Idempotency/memoization via the log: returns a previously-recorded
   * CANONICAL terminal result for this tool-call id (`tool.result` already in
   * the log). Success and canonical denial errors count; provider transport
   * placeholders do not. This is the one mechanism behind tool idempotency and
   * checkpoint-resume safety.
   */
  appliedToolResult(toolCallId: string): Promise<ToolResult | undefined>;

  /** Cooperative cancellation: check if this run has been cancelled. */
  isCancelled(): Promise<boolean>;

  /**
   * True when this run already has a `run.started` event in the log — i.e. this
   * is a resume/replay execution, not a fresh start. The runner uses this to
   * avoid re-emitting the initial `run.started`/`message.user` on resume.
   */
  hasStarted(): Promise<boolean>;
}
```

### ApprovalResult
The result of a HITL approval gate.

```ts
type ApprovalResult =
  | { approved: true }
  | { approved: false; reason?: string }
  | { status: "pending"; approvalRequestId: string };
```

### EventCategory
The category an event belongs to (AG-UI-aligned). Consumers subscribe by category, not by individual event name.

```ts
type EventCategory =
  | "lifecycle"
  | "message"
  | "tool"
  | "step"
  | "model"
  | "approval"
  | "delegation"
  | "context";
```

### RunEvent
The single, unified event taxonomy. One vocabulary serves persistence, the trace tree, the SSE stream, hooks, and cost — emitted once via `RunContext.emit`. **`text.delta` is the one exception: it is transient (D13)** — a wire/SSE shape for live token streaming that is *never* persisted, folded, or retained. It rides the out-of-band [`DeltaBus`](#streamdelta--deltabus) (from coalesced provider [`ModelStreamEvent`](#modelstreamevent)s), and the store's `append` path *rejects* it as a guard. The durable turn output stays the single `message.assistant`.

```ts
type RunEvent =
  // lifecycle
  | { type: "run.started"; trigger?: string; input?: unknown; agentVersion?: string; model?: string; threadId?: string; userId?: string; spanKind?: "agent" | "workflow" }
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
```

> **User turns are events.** `message.user` records a user/external turn delivered into a run — the initial input *and* every subsequent turn delivered via [`/runs/:id/input`](03-platform.md#gateway). Because it is in the log, it folds into `ctx.messages()` (so a resumed/revived run sees the new turn), streams over SSE, and rehydrates across a [thread's](03-platform.md#threads) runs. (`run.started.input` carries the dispatch payload; `message.user` is the conversational turn.)
>
> **`run.paused` carries a `reason`.** `"approval"` (a gated tool is awaiting resolution; `pendingApprovalIds` is set) vs `"input"` (a tool is awaiting mid-turn human input via `awaitInput()`). Both resolve via the same pause/resume-by-replay path, but the gateway uses the reason to route `/runs/:id/input` (deliver a `message.user` for `"input"`; expect an `approval.resolved` for `"approval"`). The run's [`RunStatus`](#runstatus) is `"paused"` in both cases. (Chat *turn-taking* is not a pause — under D12 each turn is its own run; see [`Agent.interactive`](#agent).)
>
> **`run.started` seeds the run's root span.** `spanKind` selects the root [`SpanKind`](#spankind): a `workflow()` dispatch emits `spanKind: "workflow"` (the handler orchestrates; it is not itself an agent), while an agent invocation defaults to `"agent"`. `model`/`agentVersion` seed the agent span's required [observability attributes](03-platform.md#observability) (token usage and iteration count then accumulate from the run's `llm.call` events).

### RunEventRecord
A persisted event in the append-only log — the source of truth all projections fold from. History is immutable; `version` carries the event-schema version.

```ts
interface RunEventRecord {
  id: string;
  runId: string;
  /** Total order within the run (gap-free, assigned on append). */
  seq: number;
  ts: string;
  category: EventCategory;
  type: RunEvent["type"];
  agentName?: string;
  /** Set on span-producing events (agent/llm/tool/step) so the trace tree is a projection. */
  spanId?: string;
  parentSpanId?: string;
  payload: RunEvent;
  version: number;
}
```

### EventLogStore
The append-only log and its readers. The only write surface; projections are maintained by folding appended events.

```ts
interface EventLogStore {
  /** Append an event. Assigns `seq`, updates maintained projections, and NOTIFYs the stream — atomically. */
  append(event: RunEventRecord): Promise<void>;
  /** Read events in order, optionally from a `seq` offset (for replay). */
  read(runId: string, fromSeq?: number): Promise<RunEventRecord[]>;
  /** Live tail for SSE: yields events as they are appended (Postgres LISTEN/NOTIFY). */
  tail(filter: { runId?: string; threadId?: string }, signal: AbortSignal): AsyncIterable<RunEventRecord>;
}
```

### EventInterceptor
A minimal, persistence-level append seam run **pre-commit** by `events.append`, before an event is persisted/projected/NOTIFYed. It references only the event vocabulary (no authoring/runtime types), so the bottom `store` layer stays free of higher-layer concepts. The user-facing [`Hook`](#hook) contract is defined in `@render-agents/engine` and **adapted onto this seam** (then injected at runtime composition via [`AgentRuntime`](#agentruntime)). This indirection is what lets hooks be "runtime middleware" while the append path remains a pure persistence concern. Returns `continue` (optionally with a rewritten event) or `reject` (veto, surfaced by the runtime — e.g. a rejected `tool.called` becomes an error `tool_result`).

```ts
interface EventInterceptor {
  /** Called for each event before append. `meta` carries run-scoped identity the store already knows. */
  intercept(
    event: RunEvent,
    meta: { runId: string; agentName?: string },
  ): Promise<
    | { action: "continue"; event?: RunEvent }   // optionally rewritten
    | { action: "reject"; reason: string }
  >;
}
```

> The runtime composes the discovered [`Hook`](#hook)s + `createRuntime({ hooks })` into a [`HookRegistry`](#hookregistry), wraps it in an `EventInterceptor` adapter (building [`HookContext`](#hookcontext) from `meta` + injected `logger`/`env`), and hands that interceptor to the store's append path. `events.append` knows only `EventInterceptor`, never `Hook`.

### Hook
Middleware that subscribes to the event stream. Hooks observe events for side effects (logging, metrics, notifications) and gate-category hooks may veto or rewrite an event *before* it is appended (e.g. block a `tool.called`). Discovered from `hooks/`, applied to all runs.

```ts
interface Hook {
  readonly name: string;
  /** Event types or whole categories this hook reacts to. */
  readonly on: (EventCategory | RunEvent["type"])[];
  /**
   * Called for each matching event before append. Observation-only hooks return
   * `{ action: "continue" }`. Gate hooks may rewrite the event or veto it.
   */
  handle(event: RunEvent, ctx: HookContext): Promise<HookResult>;
}
```

### HookResult
The outcome a hook returns for an event: continue (optionally rewritten) or reject (veto).

```ts
type HookResult =
  | { action: "continue"; event?: RunEvent }   // optionally rewritten
  | { action: "reject"; reason: string };       // veto (e.g. deny a tool call)
```

### HookContext
The context passed to a hook's `handle`.

```ts
interface HookContext {
  readonly runId: string;
  readonly agentName?: string;
  readonly logger: Logger;
  env(name: string): string | undefined;
}
```

### HookRegistry
The discovered set of hooks, keyed by name.

```ts
interface HookRegistry {
  get(name: string): Hook;
  has(name: string): boolean;
  ids(): string[];
}
```

### defineHook
Identity helper for authoring a hook in `hooks/` with full type inference.

```ts
function defineHook(spec: Hook): Hook;
```

### ContextManager
Manages the model-visible window. Called before each model call to compact history when it grows past the threshold, while the full history stays in the event log.

```ts
interface ContextManager {
  /** Returns the model-visible messages for the next call, compacting if needed (emitting `context.compacted`). */
  prepare(messages: Message[], ctx: ContextPrepareContext): Promise<Message[]>;
}

interface ContextPrepareContext {
  readonly model: ModelSpec;
  readonly agentName: string;
  readonly maxContextTokens: number;
  /** Emit a `context.compacted` event when compaction occurs. */
  emit(event: RunEvent): Promise<void>;
}
```

### CompactionStrategy
A named context-compaction strategy. The default "auto" summarizes older turns while preserving decisions/unresolved items, drops redundant tool output, and keeps recent turns verbatim.

```ts
interface CompactionStrategy {
  readonly name: string;
  shouldCompact(messages: Message[], usedTokens: number, maxTokens: number): boolean;
  /** `modelSpec` selects the provider/model used for summarization (defaults to a small tier). */
  compact(messages: Message[], modelSpec?: ModelSpec): Promise<{ messages: Message[]; summary: string }>;
}
```

### workflow
Binds config + handler into a Render Workflows root task.

```ts
/** With config. */
function workflow(
  opts: WorkflowOptions,
  handler: (ctx: WorkflowContext) => Promise<unknown>,
): WorkflowDefinition;

/** Handler only — no config, name inferred from directory. */
function workflow(
  handler: (ctx: WorkflowContext) => Promise<unknown>,
): WorkflowDefinition;
```

### WorkflowOptions
Optional configuration for a workflow root task.

```ts
interface WorkflowOptions {
  /** Explicit workflow name; otherwise inferred from the `workflows/<dir>` directory at discovery. */
  name?: string;
  /** Root task timeout in seconds. */
  timeout?: number;
  /**
   * Automatic retries of the root handler on failure. Default 0.
   * Render retries re-execute the WHOLE handler (no deterministic replay), so
   * the default avoids duplicate side effects. Durability comes from child
   * agent.task() runs and Postgres checkpoint/resume, not handler re-runs.
   */
  retries?: number;
  /** Plan for the root task container. */
  plan?: RenderPlan;
}
```

### WorkflowContext
The run-scoped context passed to a workflow handler.

```ts
interface WorkflowContext {
  readonly runId: string;
  readonly trigger: string;
  readonly input: unknown;
  /**
   * The project's full AgentSet (every agent in agents/), bound to THIS run.
   * The ONLY supported way to access agents inside a handler.
   */
  readonly agents: AgentSet;
  readonly tracer: Tracer;
  readonly logger: Logger;
  readonly signal: AbortSignal;
  /** The user this run belongs to (from the gateway's auth). Undefined for system/cron runs. Propagates to child agent runs and tool contexts. */
  readonly userId?: string;

  /**
   * Memoized deterministic step. The result is persisted by (runId, name); on
   * handler re-execution (resume/retry) the stored result is returned without
   * re-running `fn`. Use this for any side-effecting or non-deterministic work
   * in the handler body. Step names must be unique within a workflow.
   */
  step<T>(name: string, fn: () => Promise<T>): Promise<T>;
}
```

### WorkflowDefinition
The discovered, dispatchable workflow.

```ts
interface WorkflowDefinition {
  /** Set at discovery time from `workflows/<dir>` directory name. */
  readonly name: string;
  readonly options: WorkflowOptions;
  dispatch(input: unknown, trigger?: string, opts?: WorkflowDispatchOptions): Promise<RunRecord>;
  /**
   * Drive (or re-drive) the handler for an *already-started* run, recovering
   * input/trigger/identity from the run record. Unlike `dispatch`, it does not
   * emit `run.started` or generate a run id — the runner uses it to execute a
   * claimed `workflow` job and to re-drive a crashed run (idempotent via
   * `ctx.step` memoization + deterministic child dispatch keys). Throws
   * `RunPaused` if a child run parks the handler.
   */
  drive(runId: string, opts?: { signal?: AbortSignal }): Promise<void>;
}
```

### WorkflowDispatchOptions
Optional identity carried into a workflow dispatch so a thread spans the runs it triggers.

```ts
interface WorkflowDispatchOptions {
  threadId?: string;
  userId?: string;
}
```

### WebhookAdapter
A user-authored inbound event adapter.

```ts
interface WebhookAdapter {
  readonly name: string;
  match(req: Request): WebhookMatch | null;
  parse(req: Request): Promise<unknown>;
}
```

### WebhookMatch
A matched webhook's workflow dispatch target.

```ts
interface WebhookMatch {
  workflow: string;
  trigger: string;
}
```

### idempotencyKey
Deterministic key for deduplicating execution. Two uses (same helper, different inputs): the **tool-call key** `SHA-256(runId + toolCallId)` dedupes tool execution using a canonical terminal `tool.result` event; the **dispatch key** `SHA-256(runId + agentName + callSeq)` dedupes child-task dispatch. Both are answered by a single lookup against the event log (a matching canonical terminal `tool.result` / `subagent.spawned` event) — there is no separate tool-call store.

```ts
function idempotencyKey(runId: string, suffix: string): string;
```

> **No `ToolCallStore`.** Tool-call idempotency and the former `ToolCallRecord`/`ToolCallStore` are superseded by the event log: `tool.called`/`tool.result` events are the record, and `RunContext.appliedToolResult` (a log lookup) is the check. The `tool_calls` table becomes a maintained projection (see [Platform](03-platform.md#store--postgres-schema)).

### CancelStore
The cooperative cancellation flag store.

```ts
interface CancelStore {
  /** Set the cancel flag for a run. */
  requestCancel(runId: string): Promise<void>;
  /** Check if a run has been cancelled. Polled each iteration. */
  isCancelled(runId: string): Promise<boolean>;
  /** Clear the cancel flag (on run completion). */
  clearCancel(runId: string): Promise<void>;
}
```

### AgentRuntime
The composition root binding model, store, tracer, runners, job queue, workflow registry, and dispatcher.

> The `store` owns the persistence vocabulary, but for ergonomics the runtime also surfaces the operational stores (`threadStore`, `oauthStore`) and the cross-run wiring (`agentDefinitions`, `toolSources`, `cancelStore`, `oauthRefreshers`) that the gateway and dispatcher need without reaching through `store`. `threadStore`/`oauthStore` **default to the run store** when it implements those interfaces (it does), so this is a convenience facade over the same persistence layer, not a second source of truth.

```ts
interface AgentRuntime {
  readonly store: RunStore;
  /** Thread metadata + transcript store. Defaults to the run store when it implements ThreadStore. */
  readonly threadStore: ThreadStore;
  /** OAuth connection store (per-user tokens). Defaults to the run store when it implements OAuthStore. */
  readonly oauthStore: OAuthStore;
  /** Runtime-managed schedule store. Defaults to the run store when it implements ScheduleStore. */
  readonly scheduleStore: ScheduleStore;
  /** Per-provider token refreshers, populated by the gateway from provider configs. */
  readonly oauthRefreshers: Map<string, OAuthRefresher>;
  readonly tracer: Tracer;
  readonly model: ModelClient;
  readonly runners: RunnerRegistry;
  /** Hooks subscribing to the event stream. Discovered from `hooks/`. */
  readonly hooks: HookRegistry;
  /** Context manager for compaction. Defaults to the auto strategy. */
  readonly contextManager: ContextManager;
  /** Dispatches agents as Render Workflow tasks (and workflow roots via `dispatchRoot`). Absent when no workflow server/root-trigger config is detected (local fallback to in-process run). */
  readonly dispatcher?: TaskDispatcher;
  /** Chat-lane (Lane B) durable job queue (`run_jobs`) for `agent`/`resume` jobs. Backed by Postgres when available, else in-memory. */
  readonly jobQueue: JobQueue;
  /** Transient token-delta bus (D13) for live streaming; NEVER persisted. Postgres NOTIFY (`run_deltas`) when available, else in-memory fan-out. */
  readonly deltaBus: DeltaBus;
  /** Whether chat-lane runs/resumes execute inline at the trigger or are enqueued for the warm worker. Default `inline`. */
  readonly executionMode: ExecutionMode;
  /** Cooperative cancellation store, shared across in-process runs/dispatch. */
  readonly cancelStore: CancelStore;
  /** Loaded agent definitions keyed by name. Populated by `loadAgents`; used by the dispatcher and subagent delegation. */
  readonly agentDefinitions: Map<string, AgentDefinition>;
  /** Loaded workflow definitions keyed by name. Populated by `bindWorkflow`/`loadWorkflows`; used by `dispatchRoot` (Lane A) and by the gateway to classify a paused root as a workflow for HITL resume routing. */
  readonly workflows: Map<string, WorkflowDefinition>;
  /** Subagent delegation limits (depth/fanout), if overridden. */
  readonly delegation?: Partial<DelegationLimits>;
  /** Resolved tool sources from the `tools/` directory, keyed by source id. */
  readonly toolSources: Map<string, ToolSource>;
}
```

### RunnerRegistry
The set of available runners, keyed by name.

```ts
interface RunnerRegistry {
  get(name: string): AgentRunner;
  has(name: string): boolean;
}
```

### TaskDispatcher
Dispatches runs onto Render Workflows. Two seams: `dispatch` for *child* `agent.task()` calls (blocking, returns the child's output), and the optional `dispatchRoot` for *root* workflows (fire-and-forget, D12 Lane A). The in-process fallback implements both inline; the Render dispatcher maps `dispatch` to a blocking task and `dispatchRoot` to a non-blocking `startTask`.

```ts
interface TaskDispatcher {
  /** Dispatch a child agent run as a Render task on the plan-tier matching `plan`; resolves with the child's output. */
  dispatch(agentName: string, input: AgentInput, opts: DispatchOptions): Promise<AgentOutput>;
  /** Trigger a workflow root (fire-and-forget): Render via `startTask("<slug>/workflow@<plan>")`, or driven inline in local dev. */
  dispatchRoot?(job: RootDispatchJob): Promise<void>;
}
```

### RootDispatchJob
The payload for triggering a workflow root via [`TaskDispatcher.dispatchRoot`](#taskdispatcher). Carries only by-name identity (never a closure) so the generic `workflowTaskHandler` on the Workflows host can resolve and drive the workflow from the deployed image (see [Execution → Run vs task dispatch](02-execution.md#run-vs-task-dispatch)).

```ts
interface RootDispatchJob {
  /** Registered workflow name to resolve and drive. */
  workflow: string;
  /** The pre-created root run's id (its `run.started` event already exists). */
  runId: string;
  /** Plan tier selecting the `workflow@<plan>` task; defaults to `standard`. */
  plan?: RenderPlan;
}
```

### DispatchOptions
Options carried with a task dispatch.

```ts
interface DispatchOptions {
  runId: string;
  parentSpanId?: string;
  /** Propagated to the child run so it shares the caller's user/OAuth identity. */
  userId?: string;
  /** Propagated to the child run so a thread spans every run it triggers. */
  threadId?: string;
  /** Delegation depth for the child run (parent depth + 1 when spawned as a subagent). */
  depth?: number;
  /** Deterministic key — SHA-256(runId + agentName + callSeq) — for idempotent re-dispatch. */
  idempotencyKey: string;
  plan?: RenderPlan;
  signal?: AbortSignal;
  /** Cancel scope (the root run id) this child belongs to (E3); cancelling the root cascades to descendants that share the scope. */
  cancelScopeId?: string;
}
```

### createRuntime
Builds a runtime, auto-detecting store, model, and dispatcher from the environment.

```ts
/** Builds a runtime, auto-detecting store, model, and dispatcher from the environment. */
function createRuntime(opts?: CreateRuntimeOptions): Promise<AgentRuntime>;
```

### CreateRuntimeOptions
Optional overrides for `createRuntime`.

```ts
/**
 * All fields are optional overrides. When omitted, each is auto-detected from
 * the environment per the Auto-detection rules.
 */
interface CreateRuntimeOptions {
  store?: RunStore;
  tracer?: Tracer;
  model?: ModelClient;
  /** Custom/unlisted model pricing, merged over the built-in MODEL_PRICING table. */
  pricing?: Record<string, ModelPricing>;
  /** Override the default ModelClient retry policy. Also configurable via env. */
  retry?: Partial<RetryPolicy>;
  runners?: RunnerRegistry;
  /** Custom runners discovered from `runners/` (keyed by name); merged with the built-in `default`. */
  extraRunners?: Map<string, AgentRunner>;
  /** Override the auto-wired Render Workflows dispatcher. */
  dispatcher?: TaskDispatcher;
  /** Auto-detect a Render Workflows dispatcher from ambient env. Default true; set false to force the in-process dispatcher (tests use this to stay hermetic). */
  autoDetectDispatcher?: boolean;
  /** Override the durable chat-lane job queue. Defaults to Postgres when available, else in-memory. */
  jobQueue?: JobQueue;
  /** Override the transient token-delta bus (D13). Defaults to Postgres NOTIFY when available, else in-memory. */
  deltaBus?: DeltaBus;
  /** Execution mode for root runs/resumes. Defaults to `RENDER_AGENTS_EXECUTION_MODE` env, else `inline`. */
  executionMode?: ExecutionMode;
  /** Cooperative cancellation store. Defaults to a Postgres-backed flag (or in-memory). */
  cancelStore?: CancelStore;
  /** Subagent delegation limits. Also configurable via env. */
  delegation?: Partial<DelegationLimits>;
  /** Additional hooks, merged with those discovered from `hooks/`. */
  hooks?: Hook[];
  /** Override the default context manager / compaction strategy. */
  contextManager?: ContextManager;
  /** Pre-resolved tool sources (e.g. from the loader), keyed by source id, so agents can mount tools at run time. */
  toolSources?: Map<string, ToolSource>;
  /** Per-provider OAuth token refreshers (token-endpoint exchange), keyed by provider. */
  oauthRefreshers?: Map<string, OAuthRefresher>;
}
```

### DelegationLimits
Subagent delegation safety limits.

```ts
interface DelegationLimits {
  /** Max delegation nesting depth (root = 0). Default 5. */
  maxDepth: number;
  /** Max total subagent spawns per root run tree. Default 50. */
  maxFanout: number;
}
```

### loadAgents
Scans a directory, validates and binds agents to a runtime.

```ts
function loadAgents(dir?: string, runtime?: AgentRuntime): Promise<AgentSet>;
```

### mockModel
Testing helper: a programmable `ModelClient`.

```ts
function mockModel(
  handler: (args: CompleteArgs) => CompleteResult | Promise<CompleteResult>,
): ModelClient;
```

### createTestRuntime
Testing helper: an in-memory runtime with a mock/provided model, hermetic from ambient Render env.

```ts
/**
 * In-memory runtime for tests: memory store + provided/mock model. Calls
 * `createRuntime({ autoDetectDispatcher: false })` so it ignores ambient Render
 * env (e.g. inside a `render workflows dev` shell). No Render Workflows
 * dispatcher is detected, but an `InProcessDispatcher` is still installed — so
 * `.task()` runs in-process *via the dispatcher* (identical observable behavior),
 * not as a `.run()` fallback. Callers can still pass an explicit dispatcher.
 */
function createTestRuntime(opts?: Partial<CreateRuntimeOptions>): Promise<AgentRuntime>;
```

### ExecutionMode
How root runs + resumes execute relative to their trigger: `inline` drives the handler/agent/resume in the calling process; `queue` records the opening event(s) and enqueues a durable job for a `runWorker` to claim. `agent.task()` child dispatch is unaffected (always via `runtime.dispatcher`).

```ts
type ExecutionMode = "inline" | "queue";
```

### submitRootRun / SubmitRootRunOptions
Submit a root run / resume for execution honoring the runtime's [`ExecutionMode`](#executionmode): `inline` → `driveInline()` now; `queue` → enqueue a durable job. The caller records the opening event(s) first, so the run is identical regardless of mode (the job is only a pointer, D10).

```ts
interface SubmitRootRunOptions {
  runId: string;
  kind: JobKind;
  /** Forward-flex pointer payload (target name, plan, identity). */
  payload?: Record<string, unknown>;
  /** Override the kind-derived queue priority (lower = claimed first). */
  priority?: number;
  /** Drive the run to a resting state in the calling process (invoked only in `inline` mode). */
  driveInline: () => Promise<void>;
}

function submitRootRun(runtime: AgentRuntime, opts: SubmitRootRunOptions): Promise<void>;
```

### resumeRun / driveAgentTurn
`resumeRun` re-drives a paused run by replay (returning an [`AgentResult`](#agentresult) — completed or paused again); `driveAgentTurn` drives one chat-lane turn's run to completion, returning its [`AgentOutput`](#agentoutput).

```ts
function resumeRun<T = unknown>(runId: string, runtime: AgentRuntime, opts?: { signal?: AbortSignal }): Promise<AgentResult<T>>;
function driveAgentTurn(runtime: AgentRuntime, runId: string, opts?: { signal?: AbortSignal }): Promise<AgentOutput>;
```

### runWorker / runWorkerLoop / buildJobProcessor
The warm chat-lane worker (Lane B). `buildJobProcessor` turns a runtime into a [`JobProcessor`](#runworkeroptions--workerhandle--jobprocessor); `runWorkerLoop` drives a claim/process loop over a [`JobQueue`](#jobqueue); `runWorker` wires both against a runtime.

```ts
function buildJobProcessor(runtime: AgentRuntime): JobProcessor;
function runWorker(runtime: AgentRuntime, opts?: RunWorkerOptions): WorkerHandle;
function runWorkerLoop(queue: JobQueue, process: JobProcessor, opts: LoopOptions): WorkerHandle;
```

### RunWorkerOptions / WorkerHandle / JobProcessor
Configuration + handle for the worker loop, and the per-job processing function.

```ts
type JobProcessor = (job: JobRecord) => Promise<void>;

interface RunWorkerOptions {
  /** Stable id for this runner; defaults to a random id. */
  workerId?: string;
  /** Max concurrently-driven jobs. Default 4. */
  concurrency?: number;
  /** Fallback poll interval (ms) covering delayed/backoff jobs + missed NOTIFYs. Default 1000. */
  pollMs?: number;
  /** Visibility timeout (ms): a claimed job idle this long is reclaimable. Default 60000. */
  staleMs?: number;
  /** Reaper sweep interval (ms). Default = `staleMs`. */
  reapIntervalMs?: number;
  /** External stop signal (in addition to `handle.stop()`). */
  signal?: AbortSignal;
  /** Observe processing/loop errors (never thrown out of the loop). */
  onError?: (err: unknown, job?: JobRecord) => void;
}

interface WorkerHandle {
  /** Stop claiming, drain in-flight jobs, release the tail client, and resolve. */
  stop(): Promise<void>;
  /** Resolves when the loop has fully stopped and drained. */
  readonly done: Promise<void>;
}
```

### AgentTaskInput
The by-name payload handed to [`agentTaskHandler`](#agenttaskhandler--workflowtaskhandler) inside a Render Workflows task container (definitions are never serialized across the wire).

```ts
interface AgentTaskInput {
  agentName: string;
  input: AgentInput;
  runId: string;
  parentSpanId?: string;
  userId?: string;
  threadId?: string;
  depth: number;
  idempotencyKey: string;
  /** Cancel scope (root run id) so cancellation cascades into this task container (E3). */
  cancelScopeId?: string;
}
```

### InProcessDispatcherOptions
Construction options for [`InProcessDispatcher`](#inprocessdispatcher--renderworkflowsdispatcher).

```ts
interface InProcessDispatcherOptions {
  store: RunStore;
  runners: RunnerRegistry;
  model: ModelClient;
  contextManager: ContextManager;
  cancelStore: CancelStore;
  toolSources: Map<string, ToolSource>;
  getDefinition: (name: string) => AgentDefinition | undefined;
  /** Resolve a workflow by name for the in-process root drive (`dispatchRoot`). */
  getWorkflow?: (name: string) => WorkflowDefinition | undefined;
  tracer?: Tracer;
  delegation?: Partial<DelegationLimits>;
  oauthStore?: OAuthStore;
  oauthRefreshers?: Map<string, OAuthRefresher>;
  deltaBus?: DeltaBus;
}
```

### InProcessDispatcher / RenderWorkflowsDispatcher
The two [`TaskDispatcher`](#taskdispatcher) implementations: `InProcessDispatcher` runs children/roots in-process (dev/test, identical observable behavior minus isolation); `RenderWorkflowsDispatcher` maps `dispatch`→ blocking `runTask` and `dispatchRoot`→ non-blocking `startTask("<slug>/workflow@<plan>")`.

```ts
declare class InProcessDispatcher implements TaskDispatcher {
  constructor(opts: InProcessDispatcherOptions);
}
declare class RenderWorkflowsDispatcher implements TaskDispatcher {
  constructor(opts: { workflowSlug: string });
}
```

### agentTaskHandler / workflowTaskHandler
The generic host handlers executed inside a Render Workflows container: `agentTaskHandler` reloads an agent by name and runs it; `workflowTaskHandler` resolves a workflow by name and drives its root run.

```ts
function agentTaskHandler(
  taskInput: AgentTaskInput,
  runtime: AgentRuntime,
  getDefinition: (name: string) => AgentDefinition | undefined,
): Promise<AgentOutput>;
function workflowTaskHandler(
  args: { workflow: string; runId: string },
  workflows: Map<string, WorkflowDefinition>,
): Promise<{ runId: string; status: "completed" | "paused" | "cancelled" }>;
```

### computeDispatchKey / computeRequiredPlans
`computeDispatchKey` derives the deterministic child-dispatch idempotency key `SHA-256(runId + agentName + callSeq)`; `computeRequiredPlans` collects the distinct [`RenderPlan`](#renderplan)s referenced by a set of agents (so one dispatch task is registered per plan; always includes `standard`).

```ts
function computeDispatchKey(runId: string, agentName: string, callSeq: number): string;
function computeRequiredPlans(definitions: AgentDefinition[]): RenderPlan[];
```

### isWorkflowsEnvironment / isRootTriggerEnvironment
Environment probes that select the Render dispatcher: `isWorkflowsEnvironment` detects an in-container socket (`RENDER_SDK_SOCKET_PATH`/`RENDER_USE_LOCAL_DEV`) for child task chaining; `isRootTriggerEnvironment` detects the REST config (`RENDER_API_KEY` + `RENDER_WORKFLOW_SLUG`) used to trigger roots.

```ts
function isWorkflowsEnvironment(): boolean;
function isRootTriggerEnvironment(): boolean;
```

### loadWorkflows / loadWebhooks / loadToolSources / loadHooks / loadRunners
Project loaders that scan the convention directories and return the discovered definitions (validating each module's default export).

```ts
function loadWorkflows(dir: string, runtime: AgentRuntime): Promise<Map<string, WorkflowDefinition>>;
function loadWebhooks(dir: string): Promise<Map<string, WebhookAdapter>>;
function loadToolSources(dir: string): Promise<Map<string, ToolSource>>;
function loadHooks(dir: string): Promise<Hook[]>;
function loadRunners(dir: string): Promise<Map<string, AgentRunner>>;
```

---

## Engine (@render-agents/engine)

### ModelClient
The provider-agnostic model interface.

```ts
interface ModelClient {
  complete(args: CompleteArgs): Promise<CompleteResult>;
  /**
   * Streaming variant. Yields incremental deltas and returns the final
   * `CompleteResult`. The engine publishes coalesced `text_delta`s via
   * `RunContext.streamDelta()` → the out-of-band `DeltaBus` (D13); the
   * transient `text.delta` event is *never* appended to the log — the store's
   * `append` path rejects it as a guard. Optional: implementations without
   * native streaming omit it, and the engine falls back to `complete()`. The
   * durable turn output stays the single `message.assistant`.
   */
  stream?(args: CompleteArgs): AsyncGenerator<ModelStreamEvent, CompleteResult>;
}
```

### ModelStreamEvent
Provider-level streaming deltas yielded by `ModelClient.stream` (the wire format below the run). The runner lifts these into run-level [`RunEvent`](#runevent)s (`text.delta`, and `tool.*` once a tool call is assembled); they are the lowest-grain input the runner converts.

```ts
type ModelStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_use_start"; id: string; name: string }
  | { type: "tool_use_delta"; id: string; partialInput: string };
```

### CompleteArgs
The arguments to a model `complete()` call.

```ts
interface CompleteArgs {
  model: ModelSpec;
  system: string;
  tools: ToolSchema[];
  messages: Message[];
  sampling?: SamplingParams;
  /** Structured-output request. When set, the model is asked to return JSON conforming to this schema (provider-native when supported). */
  responseFormat?: { type: "json_schema"; schema: Record<string, unknown> };
  signal: AbortSignal;
}
```

### CompleteResult
The result of a model `complete()` call.

```ts
interface CompleteResult {
  content: ContentBlock[];
  usage: TokenUsage;
  stopReason: string;
}
```

### ToolSchema
The model-facing schema for a mounted tool.

```ts
interface ToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
```

### RetryPolicy
Transient-failure retry policy for the default ModelClient.

```ts
/**
 * Retry policy for the default ModelClient. Retries transient failures
 * (network errors + `retryableStatuses`) with exponential backoff + jitter,
 * honoring a `Retry-After` header when present. Retries are transparent: they
 * are NOT new loop iterations and add no token budget; `maxWallSeconds` still
 * bounds total elapsed time.
 */
interface RetryPolicy {
  maxRetries: number;          // default 3
  initialDelayMs: number;      // default 500
  maxDelayMs: number;          // default 30000
  backoffMultiplier: number;   // default 2
  retryableStatuses: number[]; // default [429, 500, 502, 503, 504]
}
```

### ModelPricing
Per-1M-token pricing for a model.

```ts
interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
  cacheReadPer1M?: number;
  cacheWritePer1M?: number;
}
```

### MODEL_PRICING
The built-in known-model pricing table.

```ts
/** Known model pricing table. Updated as new models ship. */
const MODEL_PRICING: Record<string, ModelPricing>;
```

### estimateCost
Estimates USD cost for a single LLM call.

```ts
/** Estimate cost in USD for a single LLM call. `pricing` defaults to the built-in `MODEL_PRICING` table (custom pricing layered via `createRuntime({ pricing })`). */
function estimateCost(model: string, usage: TokenUsage, pricing?: Record<string, ModelPricing>): number;
```

### RunCancelled
Control-flow signal thrown to unwind a workflow handler when its run (or an ancestor sharing its cancel scope) is cancelled (E3). Mirrors [`RunPaused`](#runpaused): the handler stops cooperatively at the next dispatch/step boundary. `scopeId` is the cancelled run that triggered the unwind.

```ts
declare class RunCancelled extends Error {
  readonly runId: string;
  readonly scopeId: string;
}
```

### OAuthRefresher
A per-provider token-endpoint exchange, keyed by provider in the runtime. Given the stored connection, returns freshly-exchanged tokens.

```ts
type OAuthRefresher = (conn: OAuthConnection) => Promise<RefreshedTokens>;
```

### InProcessRunContext
The in-process realization of [`RunContext`](#runcontext) (D2/D9): every persisting step is an `emit` to the event log. The loop talks only to the `RunContext` contract.

```ts
declare class InProcessRunContext implements RunContext { /* see RunContext */ }
```

### InProcessRunContextOptions
Construction options for [`InProcessRunContext`](#inprocessruncontext).

```ts
interface InProcessRunContextOptions {
  runId: string;
  store: RunStore;
  tracer: Tracer;
  model: ModelSpec;
  agentName: string;
  contextManager: ContextManager;
  signal: AbortSignal;
  parentSpanId?: string;
  userId?: string;
  threadId?: string;
  depth?: number;
  maxContextTokens?: number;
  logger?: Logger;
  env?: (name: string) => string | undefined;
  /** Flat tool map for tests / backward compat. */
  tools?: Map<string, Tool>;
  /** Tool sources registered from `tools/` — used by the ToolEnvironment at mount time. */
  toolSources?: Map<string, ToolSource>;
  /** Direct cancel check (legacy/tests). Prefer `cancelStore`. */
  isCancelledFn?: () => boolean | Promise<boolean>;
  cancelStore?: CancelStore;
  /** Cancel scope (root id) this run belongs to; defaults to the run's own id (E3). */
  cancelScopeId?: string;
  /** Pre-approved tool-call ids for resume after approval (bypass the gate). */
  approvedToolCallIds?: ReadonlySet<string>;
  /** Assemble model history across the whole thread (chat-lane, new-run-per-turn). */
  threadScopedHistory?: boolean;
  oauthStore?: OAuthStore;
  oauthRefreshers?: Map<string, OAuthRefresher>;
  deltaBus?: DeltaBus;
}
```

### DefaultRunnerOptions
Options for the built-in `DefaultRunner` agent loop.

```ts
interface DefaultRunnerOptions {
  /** Custom/unlisted model pricing, merged over the built-in table for cost estimation. */
  pricing?: Record<string, ModelPricing>;
}
```

### SubagentDispatcher
The dispatch seam used by `subagents__<name>` tools to spawn a child run.

```ts
interface SubagentDispatcher {
  dispatch(agentName: string, input: unknown, opts: {
    parentSpanId: string;
    userId?: string;
    depth: number;
    toolCallId: string;
  }): Promise<AgentOutput>;
}
```

### SubagentSourceOptions
Options for building an agent's subagent tool source.

```ts
interface SubagentSourceOptions {
  dispatcher: SubagentDispatcher;
  limits?: Partial<DelegationLimits>;
  currentDepth: number;
  userId?: string;
  parentSpanId: string;
  logger: Logger;
  getFanoutCount: () => Promise<number>;
}
```

### TierEntry
A concrete provider/model that a [`ModelTier`](#modeltier) alias resolves to.

```ts
interface TierEntry {
  provider: "anthropic" | "openai";
  model: string;
}
```

### ResolveModelResult
The output of resolving a model string/tier into a spec.

```ts
interface ResolveModelResult {
  spec: ModelSpec;
  warnings: string[];
}
```

### ResolveClientOptions
Options for resolving a [`ModelClient`](#modelclient) from a [`ModelSpec`](#modelspec).

```ts
interface ResolveClientOptions {
  retry?: Partial<RetryPolicy>;
}
```

---

## Store (@render-agents/store)

### SpanKind
The kind of an observability span.

```ts
type SpanKind = "workflow" | "agent" | "llm" | "tool" | "step";
```

### SpanInfo
The identity of a span at start time.

```ts
interface SpanInfo {
  spanId: string;
  parentSpanId?: string;
  runId: string;
  name: string;
  kind: SpanKind;
}
```

### SpanOutcome
The terminal outcome of a span.

```ts
type SpanOutcome =
  | { ok: true; output: unknown }
  | { ok: false; error: string };
```

### Tracer
The span emitter interface.

```ts
interface Tracer {
  onStart(span: SpanInfo, input: unknown): void;
  onEnd(span: SpanInfo, outcome: SpanOutcome): void;
}
```

### RunStatus
The lifecycle status of a run.

```ts
type RunStatus = "pending" | "running" | "paused" | "completed" | "failed" | "cancelled";
```

`"paused"` covers **both** pause reasons (awaiting approval and awaiting input — see [`run.paused`](#runevent)); the reason is carried on the pause event, not the status. For a [thread](#thread), `"running"` means mid-turn (a new message → `409 thread_busy`) while `"paused"` means deliverable. `"paused"` is an **active** state for the single-active-run index, so an awaiting run still holds its thread.

### SpanStatus
The lifecycle status of a span.

```ts
type SpanStatus = "running" | "ok" | "error";
```

### RunRecord
The persisted record of a run.

`RunRecord` is a **summary projection** of the event log, maintained on append — a fast read for "current state" (list/detail/status). It is derived, not an independently-authored source of truth; status comes from the latest lifecycle event and `totalCostUsd` folds over `llm.call` events. Operationally, this summary may be retained longer than detailed event history. There is no `cursor` field — resume position is the log offset.

> **`totalCostUsd` is per-run.** It folds only *this* run's `llm.call` events. A run that dispatches isolated children (`agent.task()` / subagents) gets a **separate child `RunRecord` per child run**, each with its own honest `totalCostUsd`. The "all-in" cost of a delegating run is therefore an **aggregate computed by the read layer**, not a single fold: walk the `subagent.spawned` events (each carries `childRunId`) recursively and sum the child runs' `totalCostUsd`. The same applies to the trace tree (see [`listSpans`](#runstore)) — the cross-run delegation tree is stitched via `subagent.spawned`, since each child run owns its own spans under its own `runId`.

```ts
interface RunRecord {
  id: string;
  workflow: string;
  status: RunStatus;
  input?: unknown;
  result?: unknown;
  error?: string;
  trigger?: string;
  /** Accumulated USD cost for THIS run, folded from this run's `llm.call` events.
   *  Cross-run (delegation) totals are aggregated by the read layer via `subagent.spawned.childRunId`. */
  totalCostUsd: number;
  /** The thread this run serves, if any. A thread spans a sequence of runs (see [Thread](#thread)). */
  threadId?: string;
  userId?: string;
  /** Agent version, when this run corresponds to a single agent invocation (audit/repro). */
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
```

### SpanRecord
A span — a **projection** of the event log: the trace tree is folded from span-producing events (`*.started`/`*.completed` pairs carrying `spanId`/`parentSpanId`). Stored in the maintained `spans` projection for efficient tree queries.

```ts
interface SpanRecord {
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
```

### ApprovalProjectionRecord
A folded approval record — the projection view of `approval.requested`/`approval.resolved` events (the operational write shape is [`ApprovalRequest`](#approvalrequest); the projection keys on `approvalRequestId` and uses `input`/optional `agentName`).

```ts
interface ApprovalProjectionRecord {
  approvalRequestId: string;
  runId: string;
  toolName: string;
  input: unknown;
  agentName?: string;
  status: "pending" | "approved" | "denied";
  requestedAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
  reason?: string;
}
```

### ProjectionSnapshot
A plain snapshot of every projection for a single run — used to prove replay is byte-identical to incremental folding.

```ts
interface ProjectionSnapshot {
  run?: RunRecord;
  messages: { seq: number; agentName?: string; message: Message }[];
  spans: SpanRecord[];
  toolResults: Record<string, ToolResult>;
  steps: Record<string, unknown>;
  approvals: ApprovalProjectionRecord[];
}
```

### RunStore
The persistence interface. Writes go through the append-only [`EventLogStore`](#eventlogstore); everything else is a **read over maintained projections** folded from the log. There are no direct projection writers (no `createRun`/`startSpan`/`appendRunMessage`) — those are internal effects of `events.append`.

> **One sanctioned exception — the cancel signal.** Cancellation is an *external control signal*, not derived run state, so it is the one value written directly to the `runs` row (`status = 'cancelled'`) via [`CancelStore`](#cancelstore) — a flag the in-flight loop can poll cross-process without tailing the log. This does not make `runs` an authoritable store: the **terminal `run.cancelled` lifecycle event is still appended** by the loop when it exits, and that event is what the status projection folds for completed/audited state. Treat the directly-written `status='cancelled'` as a *request* the running loop observes and then ratifies with an event; every other field of `runs` remains a pure projection of the log.

```ts
interface RunStore {
  init(): Promise<void>;

  /** The append-only event log — the single write path. Appending folds into projections. */
  readonly events: EventLogStore;

  // Projection reads (maintained tables, folded from events):
  getRun(id: string): Promise<RunRecord | undefined>;
  listRuns(opts?: ListRunsOptions): Promise<RunRecord[]>;
  /** Child runs spawned by `runId` (their `parentSpanId` points at a span within `runId`), oldest first — used to stitch the cross-run trace. */
  listChildRuns(runId: string): Promise<RunRecord[]>;
  /** Model-visible message history for an agent, folded from `message.*`/`tool.*` events. */
  getMessages(runId: string, agentName: string): Promise<Message[]>;
  /** Thread-scoped model history: the same fold across *every run* in a thread, ordered by run start then seq. Backs chat-lane multi-turn memory (D12); optional — a store without it falls back to run-scoped `getMessages`. */
  getThreadAgentMessages?(threadId: string, agentName: string): Promise<Message[]>;
  /** The span/trace tree for a single run, folded from its span-producing events.
   *  Child `agent.task()`/subagent runs own their spans under their own `runId`; the cross-run
   *  delegation tree is assembled by following `subagent.spawned.childRunId` (read-layer concern). */
  listSpans(runId: string): Promise<SpanRecord[]>;
  /** Memoized `ctx.step` result, read from the `step.completed` event for `(runId, name)`. */
  getStepResult(runId: string, name: string): Promise<{ value: unknown } | undefined>;
  /** Idempotency lookup: canonical terminal result for a tool-call id, from its `tool.result` event. */
  getToolResult(runId: string, toolCallId: string): Promise<ToolResult | undefined>;
  /** Folded approval requests for a single run. */
  getApprovals(runId: string): Promise<ApprovalProjectionRecord[]>;
  /** Folded approval requests across all runs, optionally filtered by status. */
  listApprovals(opts?: ListApprovalsOptions): Promise<ApprovalProjectionRecord[]>;
  /** Two-domain retention cleanup: trims event-detail for terminal runs past the event horizon and deletes run summaries past the run horizon. Never touches non-terminal runs, thread metadata/transcript, or schedules. */
  cleanup(opts: RetentionOptions): Promise<RetentionResult>;
  /** Fail Lane A roots stranded non-terminal (E6): `pending`/`running` runs with no active queue job whose most recent event is older than `staleMs`. Appends `run.failed`. Idempotent. */
  reapStaleRuns(opts: ReapOptions): Promise<ReapResult>;

  close(): Promise<void>;
}
```

> Messages are returned as [`Message`](#message) (the model-facing shape); the former `RunMessageRecord` is gone — message history is the `message.*`/`tool.*` slice of the event log, and `getMessages` is its projection.

### ListRunsOptions
Filter and pagination options for `listRuns`.

```ts
interface ListRunsOptions {
  workflow?: string;
  status?: RunStatus;
  /** Scope to a single thread's runs. */
  threadId?: string;
  limit?: number;
  /** Keyset cursor: runs older than this ID. More efficient than offset for large sets. */
  before?: string;
  /** When true, return only top-level roots (runs with no `parentSpanId`). */
  roots?: boolean;
}
```

### ListApprovalsOptions
Filter/limit options for `RunStore.listApprovals`.

```ts
interface ListApprovalsOptions {
  status?: "pending" | "approved" | "denied";
  limit?: number;
}
```

### RetentionOptions
Two-domain retention horizons for `RunStore.cleanup` (see Operations → Retention).

```ts
interface RetentionOptions {
  /** Event-detail horizon (run_events + detail projections). */
  eventRetentionDays: number;
  /** Run-summary horizon (the `runs` table). Should be >= eventRetentionDays. */
  runRetentionDays: number;
  /** Clock injection for tests. Defaults to now. */
  now?: Date;
}
```

### RetentionResult
The outcome of a `cleanup` pass.

```ts
interface RetentionResult {
  /** Terminal runs whose event-detail was trimmed. */
  eventDetailTrimmed: number;
  /** Terminal run summaries deleted. */
  runsDeleted: number;
}
```

### ReapOptions
Options for the stranded-run reaper (`RunStore.reapStaleRuns`, E6).

```ts
interface ReapOptions {
  /** A non-terminal run whose most recent event is older than this is considered stranded. */
  staleMs: number;
  /** Clock injection for tests. Defaults to now. */
  now?: Date;
}
```

### ReapResult
The outcome of a reap pass.

```ts
interface ReapResult {
  /** Number of stranded runs transitioned to `failed`. */
  reaped: number;
  /** The ids that were reaped. */
  runIds: string[];
}
```

### TERMINAL_STATUSES
The terminal run statuses eligible for retention trimming.

```ts
/** Terminal run statuses — only these are eligible for retention trimming. */
const TERMINAL_STATUSES: ReadonlySet<RunStatus>; // completed | failed | cancelled
```

### ScheduleRecord
A persisted scheduled-trigger record.

```ts
interface ScheduleRecord {
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
```

### ScheduleStore
The persistence interface for schedules.

```ts
interface ScheduleStore {
  createSchedule(schedule: ScheduleRecord): Promise<void>;
  getSchedule(id: string): Promise<ScheduleRecord | undefined>;
  updateSchedule(id: string, patch: Partial<ScheduleRecord>): Promise<void>;
  deleteSchedule(id: string): Promise<void>;
  listSchedules(): Promise<ScheduleRecord[]>;
  listEnabled(): Promise<ScheduleRecord[]>;
}
```

### JobKind
What a claimed [`run_jobs`](03-platform.md#store--postgres-schema) job tells the warm chat worker (Lane B) to drive. Durable workflows (Lane A) use Render as their queue, so there is **no** `workflow` kind.

```ts
type JobKind =
  | "agent"   // one interactive chat turn (new run per message, thread-scoped memory)
  | "resume"; // re-drive a chat run paused for within-turn HITL
```

### JobStatus
```ts
type JobStatus = "queued" | "running" | "done" | "failed" | "dead";
```

### JobRecord
A row in the chat-lane queue — a **pointer to a run** plus the `kind` of work, never run state (that lives in the event log, D10).

```ts
interface JobRecord {
  id: string;
  runId: string;
  kind: JobKind;
  status: JobStatus;
  /** Lower runs sooner. Default 100; `resume` enqueues at 50 to preempt fresh turns. */
  priority: number;
  /** Forward-flex pointer payload: target name, plan, identity. */
  payload?: Record<string, unknown>;
  attempts: number;
  /** Delivery/crash-loop budget; exhausted claims dead-letter. */
  maxAttempts: number;
  /** ISO timestamp; claimable only once `availableAt <= now`. */
  availableAt: string;
  lockedAt?: string;
  lockedBy?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}
```

### JobQueue
The chat-lane durable queue (control plane). The gateway `enqueue`s; the warm worker `claim`s atomically (`SELECT … FOR UPDATE SKIP LOCKED` on Postgres, an in-process critical section in memory) and drives the run, then `complete`s or `fail`s it. `maxAttempts` is a *delivery* budget (crash-loop guard), not the D3 logic-retry count — on a terminal run the worker always `complete`s (never requeues a genuinely failed handler); only an interrupted run (no terminal event) is re-driven, which resume-by-replay makes idempotent.

```ts
interface JobQueue {
  /** Enqueue a job. Idempotent per run: an existing active (queued/running) job is returned rather than duplicated. */
  enqueue(opts: EnqueueOptions): Promise<JobRecord>;
  /** Atomically claim the next available job (lowest `priority`, then oldest `availableAt`), marking it `running`. */
  claim(workerId: string): Promise<JobRecord | undefined>;
  /** Mark a claimed job `done`. */
  complete(id: string): Promise<void>;
  /** Report failure: requeue with backoff (if `requeue` + budget remain) else `failed`/`dead`. */
  fail(id: string, opts?: FailOptions): Promise<void>;
  /** Reclaim jobs stuck `running` past `staleMs` (crashed worker); returns count transitioned. */
  reap(staleMs: number): Promise<number>;
  get(id: string): Promise<JobRecord | undefined>;
  /** Count jobs by status (queue-depth metric; backs `GET /admin/jobs`). */
  countByStatus(): Promise<Record<JobStatus, number>>;
  /** Yield a tick on enqueue (LISTEN/NOTIFY or in-process signal) so an idle worker claims without polling. Pair with a poll fallback. */
  tail(signal: AbortSignal): AsyncIterable<void>;
}
```

### EnqueueOptions
The arguments to `JobQueue.enqueue`.

```ts
interface EnqueueOptions {
  runId: string;
  kind: JobKind;
  /** Default 100. */
  priority?: number;
  payload?: Record<string, unknown>;
  /** Delivery budget. Default 5. */
  maxAttempts?: number;
  /** Delay availability (e.g. scheduled wake). Default: now. */
  availableAt?: string;
  /** Explicit id (else generated). */
  id?: string;
}
```

### FailOptions
The options to `JobQueue.fail`.

```ts
interface FailOptions {
  /** Requeue for another attempt (subject to `maxAttempts`). Default false. */
  requeue?: boolean;
  /** Delay before a requeued job becomes available, in ms. Default 0. */
  backoffMs?: number;
  /** Error message recorded on the job for diagnostics. */
  error?: string;
}
```

### StreamDelta / DeltaBus
The transient token-streaming side channel (D13). A `DeltaBus` carries coalesced `text.delta`s **out-of-band** from the event log: `MemoryDeltaBus` fans out in-process (inline dev/tests); `PgDeltaBus` uses `pg_notify('run_deltas')` with a **single shared `LISTEN` connection per process**, demultiplexed to per-run/-thread subscribers. Deltas are never appended to `run_events`, never folded into a projection, and never retained — the append path *rejects* a transient event as a guard. `createDeltaBus({ store })` auto-selects the backend (Postgres when the store is Postgres-backed, else memory), mirroring `createJobQueue`.

```ts
interface StreamDelta {
  runId: string;
  /** Set so a thread SSE stream can filter without a DB lookup on the hot path. */
  threadId?: string;
  agentName: string;
  /** Per-run monotonic delta sequence, independent of `run_events.seq`. */
  seq: number;
  text: string;
}

interface DeltaBus {
  /** Publish one coalesced delta. Best-effort, non-durable — never throws into the loop. */
  publish(delta: StreamDelta): Promise<void>;
  /** Live subscription to deltas matching a run or thread. Yields only deltas published after subscription (no catch-up). */
  subscribe(filter: { runId?: string; threadId?: string }, signal: AbortSignal): AsyncIterable<StreamDelta>;
}
```

> The thread/approval/OAuth **persistence interfaces and their record types below are physically defined in `@render-agents/store`** (it owns persistence), even though their *routes* and request/response handling live in `@render-agents/gateway`. `gateway` imports these down the graph; `store` never imports from `gateway`.

### Thread
A durable, ordered line of work that **spans a sequence of runs** over its lifetime (at most one active at a time). The thread is the stable identity and message history; runs are the executions that serve it. A thread may be **autonomous** (a workflow root that drives to completion with no external input — Lane A) or **interactive** (a chat surface where **each user turn is its own short run** driven by the warm worker — Lane B; see [D12](00-foundations.md#d12--two-execution-lanes-durable-workflows-vs-interactive-chat)). The message history is the `message.*`/`tool.*` slice of the event log across all the thread's runs (see [`getThreadMessages`](#threadstore) for the human transcript and [`getThreadAgentMessages`](#runstore) for the model-visible thread-scoped history a new turn folds in). The thread does **not** carry an "active run" pointer: the active run is a projection of the `runs` table (the thread's one non-terminal root run, enforced by `idx_runs_thread_active`), so clients that need it derive it via `GET /runs?threadId=<id>` rather than reading it off the domain object. A thread is the **top-level unit of work** — it carries its own `userId` (owner, from auth) and `metadata`; there is no separate session grouping (filter threads by `userId` for "everything this user is doing").

```ts
interface Thread {
  id: string;
  /** Owner, from the gateway's auth. Undefined for system/unauthenticated threads. Filter by this for a user's threads. */
  userId?: string;
  metadata?: Record<string, unknown>;
  status: "active" | "idle" | "completed" | "failed" | "cancelled";
  title?: string;
  createdAt: string;
  updatedAt: string;
}
```

### ThreadMessage
A single user/assistant turn in a thread, linked to the run that produced (or received) it. A thread's turns span its runs. As a **projection** of `message.user`/`message.assistant` events, a turn is identified by its **source event coordinate** `(runId, seq)` — so the fold is an idempotent upsert and the table rebuilds byte-identically on replay (the same rebuildability invariant as every other projection; not an independently-authored row with a random key).

```ts
interface ThreadMessage {
  /** Deterministic, derived from the source event: `${runId}:${seq}` (stable across rebuilds — not a random UUID). */
  id: string;
  threadId: string;
  /** The run whose log this turn lives in. Required: every turn folds from an event in some run. */
  runId: string;
  /** Event sequence within `runId`; `(runId, seq)` is the natural key. */
  seq: number;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}
```

### ThreadStore
The persistence interface for threads. Threads are operational records (created/updated directly). **Thread turns are not** — they are a projection of `message.user`/`message.assistant` events (recorded via the run's [`events.append`](#runstore), not a direct writer here), so the store exposes only a read for them.

```ts
interface ThreadStore {
  createThread(thread: Thread): Promise<void>;
  getThread(id: string): Promise<Thread | undefined>;
  updateThread(id: string, patch: Partial<Thread>): Promise<void>;
  /** List threads, optionally scoped to one owner. */
  listThreads(opts?: { userId?: string }): Promise<Thread[]>;
  /** Full turn history for a thread, across all its runs (projection of `message.*`; used to rehydrate a revived run's context). */
  getThreadMessages(threadId: string): Promise<ThreadMessage[]>;
}
```

### ApprovalRequest
A persisted HITL approval request.

```ts
interface ApprovalRequest {
  id: string;
  runId: string;
  toolName: string;
  toolInput: unknown;
  agentName: string;
  status: "pending" | "approved" | "denied";
  requestedAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
  reason?: string;
}
```

### ApprovalStore
The persistence interface for approvals.

```ts
interface ApprovalStore {
  createRequest(req: ApprovalRequest): Promise<void>;
  getRequest(id: string): Promise<ApprovalRequest | undefined>;
  listPending(runId: string): Promise<ApprovalRequest[]>;
  resolve(id: string, decision: { approved: boolean; resolvedBy?: string; reason?: string }): Promise<void>;
}
```

### OAuthConnection
A persisted per-user OAuth connection.

```ts
interface OAuthConnection {
  id: string;
  userId: string;
  provider: string;
  accessToken: string;      // encrypted at rest
  refreshToken?: string;    // encrypted at rest
  expiresAt?: string;
  scopes: string[];
  createdAt: string;
  updatedAt: string;
}
```

### RefreshedTokens
Freshly-exchanged token material returned by a provider refresh (fed back into the stored connection by `OAuthStore.refreshConnection`).

```ts
interface RefreshedTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
}
```

### OAuthStore
The persistence interface for OAuth connections.

```ts
interface OAuthStore {
  getConnection(userId: string, provider: string): Promise<OAuthConnection | undefined>;
  upsertConnection(conn: OAuthConnection): Promise<void>;
  deleteConnection(userId: string, provider: string): Promise<void>;
  listConnections(userId: string): Promise<OAuthConnection[]>;
  /**
   * Single-flight token refresh. Acquires an exclusive lock on the connection
   * (Postgres `SELECT ... FOR UPDATE`; in-process mutex for memory), re-checks
   * freshness under the lock, and only then invokes `doRefresh` so concurrent
   * callers coalesce into one provider refresh. Returns the current/refreshed connection.
   */
  refreshConnection(
    userId: string,
    provider: string,
    isExpired: (conn: OAuthConnection) => boolean,
    doRefresh: (conn: OAuthConnection) => Promise<RefreshedTokens>,
  ): Promise<OAuthConnection | undefined>;
}
```

### PoolConfig
Postgres connection-pool configuration shared by the store/queue/bus factories.

```ts
interface PoolConfig {
  connectionString?: string;
  max?: number;
  applicationName?: string;
}
```

### CreateStoreOptions
Options for `createStore` (auto-detecting `RunStore` factory).

```ts
interface CreateStoreOptions extends PoolConfig {
  /** Force a store type. Auto-detects Postgres when `DATABASE_URL` is present, else memory. */
  type?: "memory" | "postgres";
}
```

### CreateJobQueueOptions
Options for `createJobQueue` (auto-detecting `JobQueue` factory).

```ts
interface CreateJobQueueOptions extends PoolConfig {
  /** Force a queue type. Defaults to postgres when a pool/`DATABASE_URL` is available, else memory. */
  type?: "memory" | "postgres";
  /** Share an existing pool (e.g. the run store's) instead of opening another. */
  pool?: Pool;
}
```

### CreateDeltaBusOptions
Options for `createDeltaBus` (auto-detecting `DeltaBus` factory).

```ts
interface CreateDeltaBusOptions extends PoolConfig {
  /** Force a bus type. Defaults to postgres when the store is Postgres-backed, else memory. */
  type?: "memory" | "postgres";
  /** Share an existing pool (e.g. the run store's) instead of opening another. */
  pool?: Pool;
}
```

### EventRejectedError
Thrown by `events.append` when an [`EventInterceptor`](#eventinterceptor)/hook vetoes an event (or a transient `text.delta` reaches the append path).

```ts
declare class EventRejectedError extends Error {
  readonly reason: string;
}
```

---

## Gateway (@render-agents/gateway)

### ConnectorSpec
A package-contributed inbound webhook endpoint.

```ts
interface ConnectorSpec {
  /** Route key: mounted at `/connectors/:key`. */
  readonly key: string;
  /** Human-readable name. */
  readonly name: string;
  /** Handle the inbound webhook request. Returns a workflow dispatch. */
  handle(req: Request, ctx: ConnectorContext): Promise<WebhookMatch | null>;
}
```

### ConnectorContext
The context passed to a connector's `handle`.

```ts
interface ConnectorContext {
  env(name: string): string | undefined;
  readonly logger: Logger;
}
```

### GatewayOptions
Configuration for `createGatewayApp`/`startGateway`.

```ts
interface GatewayOptions {
  runtime: AgentRuntime;
  workflows?: Map<string, WorkflowDefinition>;
  cancelStore?: CancelStore;
  port?: number;
  defaultWorkflow?: string;
  /** Conversational agent for threads; a thread's first message dispatches this (interactive) run, later messages resume it. Falls back to `defaultWorkflow` when unset. */
  defaultAgent?: string;
  baseUrl?: string;
  oauthProviders?: Map<string, OAuthProviderConfig>;
  webhooks?: Map<string, WebhookAdapter>;
  connectors?: Map<string, ConnectorSpec>;
  /** Resume driver for paused runs. Defaults to in-process `resumeRun`; injectable for tests / workflow-service dispatch. */
  resume?: (runId: string) => Promise<unknown>;
  /** Await the resume driver before responding to resolve/input requests. Default false (fire-and-forget). */
  awaitResume?: boolean;
  /** Serve the operator UI SPA at `/ui` (default true). */
  serveUI?: boolean;
  /** Disable auth for local dev (NOT for production). */
  disableAuth?: boolean;
}
```

### OAuthProviderConfig
Per-provider OAuth app configuration used by the gateway's OAuth routes.

```ts
interface OAuthProviderConfig {
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
}
```

### OAuthRouteDeps
Dependencies injected into the gateway's OAuth authorize/callback/revoke routes.

```ts
interface OAuthRouteDeps {
  providers: Map<string, OAuthProviderConfig>;
  baseUrl: string;
  oauthStore: OAuthStore;
  /** Injectable fetch for tests (defaults to global fetch). */
  fetchImpl?: typeof fetch;
}
```

### SpanLike
The minimal span shape the operator UI's trace-tree builder reads (a structural superset satisfied by [`SpanRecord`](#spanrecord)).

```ts
interface SpanLike {
  id: string;
  parentId?: string;
  seq: number;
  name: string;
  kind: string;
  status: string;
  startedAt?: string;
  finishedAt?: string;
  attributes?: Record<string, unknown>;
  runId?: string;
  input?: unknown;
  output?: unknown;
}
```

### SpanNode
A [`SpanLike`](#spanlike) node in the assembled collapsible trace tree, with its children and computed depth.

```ts
interface SpanNode extends SpanLike {
  children: SpanNode[];
  depth: number;
}
```
