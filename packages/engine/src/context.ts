import type { RunEvent, Message, Logger, Tracer, ContentBlock, ToolResult } from "@render-agents/store";
import type { MountedTools, OAuthTokens } from "./tool.js";
import type { AgentDefinition, AgentInput, AgentOutput } from "./agent.js";

export type InputResult =
  | { approved: true }
  | { approved: false; reason?: string }
  | { status: "pending"; inputRequestId: string };

export interface RunContext {
  readonly signal: AbortSignal;
  readonly logger: Logger;
  readonly tracer: Tracer;
  readonly runId: string;
  readonly parentSpanId?: string;
  readonly userId?: string;
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
   * Dispose any mounted tool sources (MCP connections / stdio child processes).
   * The runner calls this when a run reaches a terminal, paused, or cancelled
   * state so long-lived transports don't leak (CR-06). Optional so lightweight
   * test doubles need not implement it.
   */
  disposeTools?(): Promise<void>;
  requestInput(toolName: string, input: unknown, toolCallId: string): Promise<InputResult>;
  awaitInput(): Promise<ContentBlock[]>;
  emit(event: RunEvent): Promise<void>;
  /**
   * Publish a transient token delta for live streaming (D13). Fire-and-forget
   * and non-durable: it rides the out-of-band `DeltaBus`, never the event log,
   * and is a no-op when no bus is wired. The runner calls this with coalesced
   * text as the model streams; the canonical turn is still the durable
   * `message.assistant`.
   */
  streamDelta(text: string): void;
  messages(agentName: string): Promise<Message[]>;
  appliedToolResult(toolCallId: string): Promise<ToolResult | undefined>;
  isCancelled(): Promise<boolean>;
  /**
   * True when this run already has a `run.started` event in the log — i.e. this
   * is a resume/replay execution, not a fresh start. The runner uses this to
   * avoid re-emitting the initial `run.started`/`message.user` on resume.
   */
  hasStarted(): Promise<boolean>;
}

export interface AgentRunner {
  run(agent: AgentDefinition, input: AgentInput, ctx: RunContext): Promise<AgentOutput>;
}
