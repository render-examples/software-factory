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
   * Conversational agent. When true, the runner parks on `ctx.awaitInput()` after
   * a terminal turn (emitting `run.paused { reason: "input" }`) instead of
   * completing, so the run awaits the next user message — the agent-level basis
   * for an interactive thread. Default false (autonomous: drives to completion).
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
type AgentResult =
  | ({ status: "completed" } & AgentOutput)
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

  mountTools(toolIds: string[]): Promise<MountedTools>;

  /**
   * HITL gate. Production (gateway) records an `approval.requested` event and
   * returns `{ status: "pending" }`; in-process behavior follows the approval
   * mode. It does NOT block.
   */
  requestApproval(toolName: string, input: unknown): Promise<ApprovalResult>;

  /**
   * Conversational pause (sibling of `requestApproval`). An interactive run calls
   * this when it has finished a turn and wants the next user message instead of
   * completing. Production (gateway) emits `run.paused { reason: "input" }` and
   * unwinds via `RunPaused`; the run resumes when `/runs/:id/input` delivers the
   * next turn (appended as a `message.user` event) — on resume this returns that
   * turn's content. Autonomous runs never call it; they drive to completion.
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
The single, unified event taxonomy. One vocabulary serves persistence, the trace tree, the SSE stream, hooks, and cost — emitted once via `RunContext.emit`. Token-level provider deltas (see [`ModelStreamEvent`](#modelstreamevent)) are lifted by the runner into `text.delta` events; they are not a separate run vocabulary.

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
> **`run.paused` carries a `reason`.** `"approval"` (a gated tool is awaiting resolution; `pendingApprovalIds` is set) vs `"input"` (an interactive run is awaiting the next user message). Both resolve via the same pause/resume-by-replay path, but the gateway uses the reason to route `/runs/:id/input` (deliver a `message.user` for `"input"`; expect an `approval.resolved` for `"approval"`). The run's [`RunStatus`](#runstatus) is `"paused"` in both cases.
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
  compact(messages: Message[]): Promise<{ messages: Message[]; summary: string }>;
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
  dispatch(input: unknown, trigger?: string): Promise<RunRecord>;
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
The composition root binding model, store, tracer, runners, and dispatcher.

> The `store` owns the persistence vocabulary, but for ergonomics the runtime also surfaces the operational stores (`threadStore`, `oauthStore`) and the cross-run wiring (`agentDefinitions`, `toolSources`, `cancelStore`, `oauthRefreshers`) that the gateway and dispatcher need without reaching through `store`. `threadStore`/`oauthStore` **default to the run store** when it implements those interfaces (it does), so this is a convenience facade over the same persistence layer, not a second source of truth.

```ts
interface AgentRuntime {
  readonly store: RunStore;
  /** Thread metadata + transcript store. Defaults to the run store when it implements ThreadStore. */
  readonly threadStore: ThreadStore;
  /** OAuth connection store (per-user tokens). Defaults to the run store when it implements OAuthStore. */
  readonly oauthStore: OAuthStore;
  /** Per-provider token refreshers, populated by the gateway from provider configs. */
  readonly oauthRefreshers: Map<string, OAuthRefresher>;
  readonly tracer: Tracer;
  readonly model: ModelClient;
  readonly runners: RunnerRegistry;
  /** Hooks subscribing to the event stream. Discovered from `hooks/`. */
  readonly hooks: HookRegistry;
  /** Context manager for compaction. Defaults to the auto strategy. */
  readonly contextManager: ContextManager;
  /** Dispatches agents as Render Workflow tasks. Absent when no workflow server is detected (local fallback to in-process run). */
  readonly dispatcher?: TaskDispatcher;
  /** Cooperative cancellation store, shared across in-process runs/dispatch. */
  readonly cancelStore: CancelStore;
  /** Loaded agent definitions keyed by name. Populated by `loadAgents`; used by the dispatcher and subagent delegation. */
  readonly agentDefinitions: Map<string, AgentDefinition>;
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
Dispatches an agent run as a Render Workflow task.

```ts
interface TaskDispatcher {
  /** Dispatch an agent run as a Render task on the plan-tier matching `plan`. */
  dispatch(agentName: string, input: AgentInput, opts: DispatchOptions): Promise<AgentOutput>;
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
  /** Delegation depth for the child run (parent depth + 1 when spawned as a subagent). */
  depth?: number;
  /** Deterministic key — SHA-256(runId + agentName + callSeq) — for idempotent re-dispatch. */
  idempotencyKey: string;
  plan?: RenderPlan;
  signal?: AbortSignal;
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
Testing helper: an in-memory runtime with a mock/provided model and no dispatcher.

```ts
/** In-memory runtime for tests: memory store, provided/mock model, no dispatcher (so `.task()` falls back to `.run()`). */
function createTestRuntime(opts?: Partial<CreateRuntimeOptions>): Promise<AgentRuntime>;
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
   * `CompleteResult`. The engine forwards `text_delta` events via
   * `RunContext.emit` → SSE `text.delta`. Optional: implementations without
   * native streaming omit it, and the engine falls back to `complete()`
   * (one terminal text event). Token-level deltas are post-MVP.
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
/** Estimate cost in USD for a single LLM call. */
function estimateCost(model: string, usage: TokenUsage): number;
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
  /** Model-visible message history for an agent, folded from `message.*`/`tool.*` events. */
  getMessages(runId: string, agentName: string): Promise<Message[]>;
  /** The span/trace tree for a single run, folded from its span-producing events.
   *  Child `agent.task()`/subagent runs own their spans under their own `runId`; the cross-run
   *  delegation tree is assembled by following `subagent.spawned.childRunId` (read-layer concern). */
  listSpans(runId: string): Promise<SpanRecord[]>;
  /** Memoized `ctx.step` result, read from the `step.completed` event for `(runId, name)`. */
  getStepResult(runId: string, name: string): Promise<{ value: unknown } | undefined>;
  /** Idempotency lookup: canonical terminal result for a tool-call id, from its `tool.result` event. */
  getToolResult(runId: string, toolCallId: string): Promise<ToolResult | undefined>;

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
  limit?: number;
  /** Keyset cursor: runs older than this ID. More efficient than offset for large sets. */
  before?: string;
}
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

> The thread/approval/OAuth **persistence interfaces and their record types below are physically defined in `@render-agents/store`** (it owns persistence), even though their *routes* and request/response handling live in `@render-agents/gateway`. `gateway` imports these down the graph; `store` never imports from `gateway`.

### Thread
A durable, ordered line of work that **spans a sequence of runs** over its lifetime (at most one active at a time). The thread is the stable identity and message history; runs are the executions that serve it. A thread may be **autonomous** (its run(s) drive to completion with no external input) or **interactive** (it awaits external messages between turns — chat). The message history is the `message.*`/`tool.*` slice of the event log across all the thread's runs (see [`getThreadMessages`](#threadstore)); `currentRunId` is the active run, if any. A thread is the **top-level unit of work** — it carries its own `userId` (owner, from auth) and `metadata`; there is no separate session grouping (filter threads by `userId` for "everything this user is doing").

```ts
interface Thread {
  id: string;
  /** Owner, from the gateway's auth. Undefined for system/unauthenticated threads. Filter by this for a user's threads. */
  userId?: string;
  metadata?: Record<string, unknown>;
  /** The active run serving this thread right now, if one is live. */
  currentRunId?: string;
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

### OAuthStore
The persistence interface for OAuth connections.

```ts
interface OAuthStore {
  getConnection(userId: string, provider: string): Promise<OAuthConnection | undefined>;
  upsertConnection(conn: OAuthConnection): Promise<void>;
  deleteConnection(userId: string, provider: string): Promise<void>;
  listConnections(userId: string): Promise<OAuthConnection[]>;
}
```

---

## Gateway (@render-agents/gateway)

### ConnectorSpec
A package-contributed inbound webhook endpoint.

```ts
interface ConnectorSpec {
  /** Route key: mounted at `/connectors/:key`. */
  key: string;
  /** Human-readable name. */
  name: string;
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
