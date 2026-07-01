import { randomUUID } from "node:crypto";
import * as readline from "node:readline";
import type {
  RunEvent,
  Message,
  ContentBlock,
  ToolResult,
  Logger,
  Tracer,
  SpanKind,
  RunStore,
  OAuthStore,
  OAuthConnection,
  RefreshedTokens,
} from "@render-agents/store";
import { buildEventRecord, idempotencyKey } from "@render-agents/store";
import type { ModelSpec } from "./agent.js";
import { RunPaused } from "./agent.js";
import type { ContextManager } from "./context-manager.js";
import type { MountedTools, Tool, ToolSource, OAuthTokens } from "./tool.js";
import type { RunContext, ApprovalResult } from "./context.js";

/** Refreshes a provider's tokens (provided by the composition root that knows token endpoints). */
export type OAuthRefresher = (conn: OAuthConnection) => Promise<RefreshedTokens>;

/** Seconds of clock skew before expiry at which a token is considered stale. */
const TOKEN_EXPIRY_SKEW_MS = 60_000;
import { ToolEnvironment } from "./tool-impl.js";

const STRICT_APPROVAL_ENV = "RENDER_AGENTS_STRICT_APPROVAL";

const consoleLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: (msg, meta) => console.warn(msg, meta ?? ""),
  error: (msg, meta) => console.error(msg, meta ?? ""),
};

export interface InProcessRunContextOptions {
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
  /** Flat tool map for tests / backward compat (tools mounted directly by name). */
  tools?: Map<string, Tool>;
  /** Tool sources registered from the tools/ directory — used by the ToolEnvironment at mount time. */
  toolSources?: Map<string, ToolSource>;
  /** Direct cancel check (legacy/tests). Prefer cancelStore for production. */
  isCancelledFn?: () => boolean | Promise<boolean>;
  /** CancelStore for cooperative cancellation. Overrides isCancelledFn when provided. */
  cancelStore?: import("@render-agents/store").CancelStore;
  /**
   * Cancel scope this run belongs to — the id of the cancellable unit (the
   * workflow/agent root). Cancelling that root cascades to every descendant that
   * shares the scope (E3): the cancel check returns true when *either* this run
   * or its scope is cancelled. Defaults to the run's own id (root). Works across
   * Lane A task containers because the check reads the scope's status from the
   * shared store.
   */
  cancelScopeId?: string;
  /** Pre-approved tool call IDs for resume after approval (bypass approval gate). */
  approvedToolCallIds?: ReadonlySet<string>;
  /**
   * Assemble model history from the whole thread (every run sharing `threadId`)
   * rather than just this run. Set for chat-lane turns (new-run-per-turn): the
   * turn is its own run, but memory comes from the thread transcript. Requires
   * `threadId` and a store implementing `getThreadAgentMessages`.
   */
  threadScopedHistory?: boolean;
  /** OAuth store for resolving `ToolContext.connection()`; tokens are per-user. */
  oauthStore?: OAuthStore;
  /** Per-provider token refreshers (token-endpoint exchange), keyed by provider. */
  oauthRefreshers?: Map<string, OAuthRefresher>;
}

/**
 * The in-process realization of `RunContext` (D2/D9): every persisting step is
 * an `emit` to the event log. The loop talks only to this contract, so Wave 1
 * features land in the context/store rather than the loop body. Span ids are
 * correlated here so the `spans` projection can assemble the trace tree.
 */
export class InProcessRunContext implements RunContext {
  readonly signal: AbortSignal;
  readonly logger: Logger;
  readonly tracer: Tracer;
  readonly runId: string;
  readonly parentSpanId?: string;
  readonly userId?: string;
  readonly threadId?: string;
  readonly depth: number;

  private readonly store: RunStore;
  private readonly model: ModelSpec;
  private readonly agentName: string;
  private readonly contextManager: ContextManager;
  private readonly maxContextTokens: number;
  private readonly envFn: (name: string) => string | undefined;
  private readonly tools: Map<string, Tool>;
  private readonly toolSources: Map<string, ToolSource>;
  private readonly isCancelledFn: () => boolean | Promise<boolean>;
  private toolEnv?: ToolEnvironment;
  private readonly approvedToolCallIds: ReadonlySet<string>;
  private readonly threadScopedHistory: boolean;
  private readonly oauthStore?: OAuthStore;
  private readonly oauthRefreshers: Map<string, OAuthRefresher>;

  // Deterministic so resume/replay reuses the same agent span id and the
  // terminal run.completed/failed/cancelled close the original span.
  private readonly agentSpanId: string;
  private readonly toolSpanIds = new Map<string, string>();
  private readonly stepSpanIds = new Map<string, string>();

  constructor(opts: InProcessRunContextOptions) {
    this.runId = opts.runId;
    this.store = opts.store;
    this.tracer = opts.tracer;
    this.model = opts.model;
    this.agentName = opts.agentName;
    this.contextManager = opts.contextManager;
    this.signal = opts.signal;
    this.parentSpanId = opts.parentSpanId;
    this.userId = opts.userId;
    this.threadId = opts.threadId;
    this.depth = opts.depth ?? 0;
    this.maxContextTokens = opts.maxContextTokens ?? 100_000;
    this.logger = opts.logger ?? consoleLogger;
    this.envFn = opts.env ?? ((name) => process.env[name]);
    this.tools = opts.tools ?? new Map();
    this.toolSources = opts.toolSources ?? new Map();
    this.approvedToolCallIds = opts.approvedToolCallIds ?? new Set();
    this.threadScopedHistory = opts.threadScopedHistory ?? false;
    this.oauthStore = opts.oauthStore;
    this.oauthRefreshers = opts.oauthRefreshers ?? new Map();
    this.agentSpanId = idempotencyKey(opts.runId, `agent-span:${opts.agentName}`);

    if (opts.cancelStore) {
      const cancelStore = opts.cancelStore;
      const runId = opts.runId;
      // Cancel cascade (E3): a run is cancelled if its own id OR its enclosing
      // cancel scope (the root) is cancelled, so cancelling a workflow root
      // halts the descendant agent runs it dispatched.
      const scopeId = opts.cancelScopeId && opts.cancelScopeId !== runId ? opts.cancelScopeId : undefined;
      this.isCancelledFn = async () =>
        (await cancelStore.isCancelled(runId)) || (scopeId ? cancelStore.isCancelled(scopeId) : false);
    } else {
      this.isCancelledFn = opts.isCancelledFn ?? (() => false);
    }
  }

  env(name: string): string | undefined {
    return this.envFn(name);
  }

  /**
   * Resolve the current user's OAuth tokens for a provider. Reads the connection
   * from the OAuth store, and if it is expired (or about to be) and refreshable,
   * performs a single-flight refresh via the registered provider refresher.
   */
  async connection(provider: string): Promise<OAuthTokens | undefined> {
    if (!this.oauthStore || !this.userId) return undefined;
    const userId = this.userId;
    let conn = await this.oauthStore.getConnection(userId, provider);
    if (!conn) return undefined;

    const refresher = this.oauthRefreshers.get(provider);
    if (refresher && conn.refreshToken && isTokenExpired(conn.expiresAt)) {
      conn = await this.oauthStore.refreshConnection(
        userId,
        provider,
        (c) => isTokenExpired(c.expiresAt),
        refresher,
      );
      if (!conn) return undefined;
    }

    return { accessToken: conn.accessToken, refreshToken: conn.refreshToken, expiresAt: conn.expiresAt };
  }

  async emit(event: RunEvent): Promise<void> {
    // Enrich the opening event with thread/user identity from the context so the
    // run projection (and thread transcript) carry it, without the runner having
    // to thread these through. A thread spans many runs (D-thread model).
    if (event.type === "run.started") {
      if (this.threadId !== undefined && event.threadId === undefined) event = { ...event, threadId: this.threadId };
      if (this.userId !== undefined && event.userId === undefined) event = { ...event, userId: this.userId };
    }
    const span = this.spanCorrelation(event);
    const record = buildEventRecord(this.runId, event, {
      agentName: this.agentName,
      spanId: span?.spanId,
      parentSpanId: span?.parentSpanId,
    });
    await this.store.events.append(record);
    if (span) this.notifyTracer(event, span);
  }

  /**
   * Notify the (optional) external tracer as a pure observer. Span data is still
   * sourced from the event-log projections; this lets a custom tracer (e.g. an
   * OTel exporter) see every span without the loop emitting through it. The
   * default `noopTracer` does nothing.
   */
  private notifyTracer(event: RunEvent, span: { spanId: string; parentSpanId?: string }): void {
    const kind = spanKindOf(event.type);
    if (!kind) return;
    const info = { spanId: span.spanId, parentSpanId: span.parentSpanId, runId: this.runId, name: this.agentName, kind };
    try {
      switch (event.type) {
        case "run.started":
          this.tracer.onStart({ ...info, name: this.agentName }, event.input);
          break;
        case "run.completed":
          this.tracer.onEnd(info, { ok: true, output: event.result });
          break;
        case "run.failed":
          this.tracer.onEnd(info, { ok: false, error: event.error });
          break;
        case "run.cancelled":
          this.tracer.onEnd(info, { ok: false, error: "cancelled" });
          break;
        case "tool.called":
          this.tracer.onStart({ ...info, name: event.name }, event.input);
          break;
        case "tool.result":
          this.tracer.onEnd(
            { ...info, name: event.name },
            event.result.isError ? { ok: false, error: event.result.content } : { ok: true, output: event.result.content },
          );
          break;
        case "step.started":
          this.tracer.onStart({ ...info, name: event.name }, undefined);
          break;
        case "step.completed":
          this.tracer.onEnd({ ...info, name: event.name }, { ok: true, output: event.result });
          break;
        case "llm.call":
          this.tracer.onStart({ ...info, name: event.model, kind: "llm" }, undefined);
          this.tracer.onEnd({ ...info, name: event.model, kind: "llm" }, { ok: true, output: { usage: event.usage, costUsd: event.costUsd } });
          break;
      }
    } catch {
      // A misbehaving observer tracer must never break the run.
    }
  }

  async hasStarted(): Promise<boolean> {
    const events = await this.store.events.read(this.runId);
    return events.some((e) => e.payload.type === "run.started");
  }

  async messages(agentName: string): Promise<Message[]> {
    // Chat lane: assemble memory from the whole thread (every run sharing the
    // thread), not just this turn's run. Falls back to run-scoped history if the
    // store predates `getThreadAgentMessages` or no thread is set.
    const history =
      this.threadScopedHistory && this.threadId && this.store.getThreadAgentMessages
        ? await this.store.getThreadAgentMessages(this.threadId, agentName)
        : await this.store.getMessages(this.runId, agentName);
    return this.contextManager.prepare(history, {
      model: this.model,
      agentName,
      maxContextTokens: this.maxContextTokens,
      emit: (event) => this.emit(event),
    });
  }

  async appliedToolResult(toolCallId: string): Promise<ToolResult | undefined> {
    return this.store.getToolResult(this.runId, toolCallId);
  }

  async isCancelled(): Promise<boolean> {
    return this.isCancelledFn();
  }

  async mountTools(toolIds: string[]): Promise<MountedTools> {
    // If tool sources are provided, use the real ToolEnvironment mount path.
    if (this.toolSources.size > 0) {
      this.toolEnv = new ToolEnvironment();
      return this.toolEnv.mount(this.toolSources, toolIds, this.logger, this.signal);
    }
    // Fallback: flat tool map (tests, Wave 0 compat).
    const tools = toolIds
      .map((id) => this.tools.get(id))
      .filter((t): t is Tool => t !== undefined);
    return {
      tools,
      byName: (name: string) => tools.find((t) => t.name === name),
    };
  }

  /**
   * HITL gate, resolved by replay against the event log (D7). The approval id is
   * deterministic per `(runId, toolCallId)` so a resumed run looks up the same
   * request:
   * 1. Already resolved in the log → return that decision (approved/denied).
   * 2. Pre-approved tool-call id (in-process resume convenience) → approve.
   * 3. Auto-approve (default) → emit `approval.auto`, auditable.
   * 4. Strict + already requested (pending) → re-pause without a duplicate request.
   * 5. Strict + first encounter → emit `approval.requested` + `run.paused`, pause.
   * 6. Strict + interactive TTY → prompt directly.
   */
  async requestApproval(toolName: string, input: unknown, toolCallId: string): Promise<ApprovalResult> {
    const approvalId = idempotencyKey(this.runId, `approval:${toolCallId}`);

    // 1. Resolved already? Honor the recorded decision.
    const state = await this.approvalState(approvalId);
    if (state.resolved) {
      return state.approved ? { approved: true } : { approved: false, reason: state.reason };
    }

    // 2. Pre-approved tool call (resume convenience).
    if (this.approvedToolCallIds.has(toolCallId)) {
      return { approved: true };
    }

    const raw = this.envFn(STRICT_APPROVAL_ENV);
    const strict = raw !== undefined && raw !== "" && raw !== "0" && raw.toLowerCase() !== "false";

    // 3. Auto-approve (default).
    if (!strict) {
      await this.emit({ type: "approval.auto", toolName });
      return { approved: true };
    }

    // 6. Interactive TTY prompt (only when not already requested).
    if (process.stdin?.isTTY && !state.requested) {
      const approved = await promptYesNo(`Approve tool call "${toolName}"? (y/n) `);
      if (approved) {
        await this.emit({ type: "approval.auto", toolName });
        return { approved: true };
      }
      await this.emit({
        type: "approval.resolved",
        approvalRequestId: approvalId,
        approved: false,
        reason: "denied at prompt",
      });
      return { approved: false, reason: "denied at prompt" };
    }

    // 4./5. Non-interactive: request once (if not already), then pause.
    if (!state.requested) {
      await this.emit({ type: "approval.requested", approvalRequestId: approvalId, toolName, input });
    }
    await this.emit({ type: "run.paused", reason: "approval", pendingApprovalIds: [approvalId] });
    return { status: "pending", approvalRequestId: approvalId };
  }

  /** Fold approval events from the log for a specific approval id. */
  private async approvalState(approvalId: string): Promise<{ requested: boolean; resolved: boolean; approved: boolean; reason?: string }> {
    const events = await this.store.events.read(this.runId);
    let requested = false;
    let resolved = false;
    let approved = false;
    let reason: string | undefined;
    for (const e of events) {
      const p = e.payload;
      if (p.type === "approval.requested" && p.approvalRequestId === approvalId) {
        requested = true;
      } else if (p.type === "approval.resolved" && p.approvalRequestId === approvalId) {
        resolved = true;
        approved = p.approved;
        reason = p.reason;
      }
    }
    return { requested, resolved, approved, reason };
  }

  async awaitInput(): Promise<ContentBlock[]> {
    await this.emit({ type: "run.paused", reason: "input" });
    throw new RunPaused(this.runId, "input");
  }

  private spanCorrelation(event: RunEvent): { spanId: string; parentSpanId?: string } | undefined {
    switch (event.type) {
      case "run.started":
      case "run.completed":
      case "run.failed":
      case "run.cancelled":
      case "run.paused":
        return { spanId: this.agentSpanId, parentSpanId: this.parentSpanId };
      case "llm.call":
        return { spanId: randomUUID(), parentSpanId: this.agentSpanId };
      case "tool.called": {
        const id = randomUUID();
        this.toolSpanIds.set(event.toolCallId, id);
        return { spanId: id, parentSpanId: this.agentSpanId };
      }
      case "tool.result": {
        const id = this.toolSpanIds.get(event.toolCallId) ?? randomUUID();
        return { spanId: id, parentSpanId: this.agentSpanId };
      }
      case "step.started": {
        const id = randomUUID();
        this.stepSpanIds.set(event.name, id);
        return { spanId: id, parentSpanId: this.agentSpanId };
      }
      case "step.completed": {
        const id = this.stepSpanIds.get(event.name) ?? randomUUID();
        return { spanId: id, parentSpanId: this.agentSpanId };
      }
      default:
        return undefined;
    }
  }
}

/** A token with no expiry never expires; otherwise stale once within the skew window. */
function isTokenExpired(expiresAt: string | undefined): boolean {
  if (!expiresAt) return false;
  const expMs = Date.parse(expiresAt);
  if (Number.isNaN(expMs)) return false;
  return Date.now() >= expMs - TOKEN_EXPIRY_SKEW_MS;
}

function spanKindOf(type: RunEvent["type"]): SpanKind | undefined {
  switch (type) {
    case "run.started":
    case "run.completed":
    case "run.failed":
    case "run.cancelled":
      return "agent";
    case "tool.called":
    case "tool.result":
      return "tool";
    case "step.started":
    case "step.completed":
      return "step";
    case "llm.call":
      return "llm";
    default:
      return undefined;
  }
}

function promptYesNo(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}
