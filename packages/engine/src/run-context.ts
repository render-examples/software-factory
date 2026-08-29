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
  DeltaBus,
} from "@render-factory/store";
import { buildEventRecord, idempotencyKey } from "@render-factory/store";
import type { ModelSpec } from "./agent.js";
import { RunPaused } from "./agent.js";
import type { ContextManager } from "./context-manager.js";
import type { MountedTools, Tool, ToolSource, OAuthTokens } from "./tool.js";
import type { RunContext, InputResult } from "./context.js";
import type { Suspender } from "./suspender.js";
import { replaySuspender } from "./suspender.js";

// --- Types & Constants ---

export type OAuthRefresher = (conn: OAuthConnection) => Promise<RefreshedTokens>;

const TOKEN_EXPIRY_SKEW_MS = 60_000;
import { ToolEnvironment } from "./tool-impl.js";

const STRICT_APPROVAL_ENV = "RENDER_FACTORY_STRICT_APPROVAL";

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
  cancelStore?: import("@render-factory/store").CancelStore;
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
  /** Transient token-delta bus (D13). When present, `streamDelta` publishes live deltas; absent = no-op. */
  deltaBus?: DeltaBus;
  /**
   * How the run parks on HITL (approval/`awaitInput`) and is woken. Defaults to
   * `replaySuspender` (throw `RunPaused`, resume-by-replay). A
   * continuation-preserving suspender (native Render Workflows pause/resume) can
   * be injected to suspend the `await` in place instead.
   */
  suspender?: Suspender;
}

/**
 * The in-process realization of `RunContext`): every persisting step is
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
  private readonly deltaBus?: DeltaBus;
  private readonly suspender: Suspender;
  // Per-run monotonic delta sequence + a serialized publish tail so deltas keep
  // their order across `LISTEN/NOTIFY` without blocking the agent loop.
  private deltaSeq = 0;
  private deltaTail: Promise<void> = Promise.resolve();
  private readonly consumedMessageInputIds = new Set<string>();

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
    this.deltaBus = opts.deltaBus;
    this.suspender = opts.suspender ?? replaySuspender;
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

  // --- Environment & Credentials ---

  env(name: string): string | undefined {
    return this.envFn(name);
  }

  /**
   * Resolve the current user's OAuth tokens for a provider. Refreshes if expired.
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

  // --- Event Emission & Streaming ---

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

  streamDelta(text: string): void {
    const bus = this.deltaBus;
    if (!bus || text.length === 0) return;
    const delta = {
      runId: this.runId,
      threadId: this.threadId,
      agentName: this.agentName,
      seq: ++this.deltaSeq,
      text,
    };
    // Serialize publishes to preserve order; never let a NOTIFY failure or its
    // latency surface into the loop (streaming is best-effort UX).
    this.deltaTail = this.deltaTail.then(() => bus.publish(delta)).catch(() => {});
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

  // --- History & Replay ---

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

  // --- Tool Mounting ---

  async mountTools(toolIds: string[]): Promise<MountedTools> {
    // Dispose a previously-mounted environment before remounting so MCP
    // connections / child processes from a prior mount don't leak (CR-06).
    await this.toolEnv?.dispose();
    // If tool sources are provided, use the real ToolEnvironment mount path.
    if (this.toolSources.size > 0) {
      this.toolEnv = new ToolEnvironment();
      try {
        return await this.toolEnv.mount(this.toolSources, toolIds, this.logger, this.signal);
      } catch (err) {
        // If mounting fails partway through, close any already-opened sources
        // before surfacing the error so failed mounts don't leak processes/sockets.
        await this.toolEnv.dispose().catch(() => {});
        this.toolEnv = undefined;
        throw err;
      }
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

  async disposeTools(): Promise<void> {
    await this.toolEnv?.dispose();
    this.toolEnv = undefined;
  }

  // --- HITL (Human-in-the-Loop) ---

  /**
   * Approval gate, resolved by replay against the event log (D7). Deterministic
   * approval id per `(runId, toolCallId)`. Resolution paths:
   * 1. Already resolved → return decision. 2. Pre-approved → approve.
   * 3. Auto-approve (default). 4/5. Strict → emit request + pause.
   * 6. Strict + TTY → prompt directly.
   */
  async requestInput(toolName: string, input: unknown, toolCallId: string): Promise<InputResult> {
    const inputRequestId = idempotencyKey(this.runId, `input:approval:${toolCallId}`);

    // 1. Resolved already? Honor the recorded decision.
    const state = await this.inputState(inputRequestId);
    if (state.resolved && state.approved !== undefined) {
      return state.approved ? { approved: true } : { approved: false, reason: state.reason };
    }

    // 2. Pre-approved tool call (resume convenience).
    if (this.approvedToolCallIds.has(toolCallId)) {
      return { approved: true };
    }

    const raw = this.envFn(STRICT_APPROVAL_ENV);
    const explicitlyDisabled = raw === "0" || (raw ?? "").toLowerCase() === "false";
    const explicitlyEnabled = raw !== undefined && raw !== "" && !explicitlyDisabled;
    // Fail safe (CR-17): gated tools require approval by default in production
    // (explicit opt-out required); dev/test keep auto-approve for convenience.
    const strict =
      explicitlyEnabled || (process.env.NODE_ENV === "production" && !explicitlyDisabled);

    // 3. Auto-approve (default).
    if (!strict) {
      await this.emit({ type: "input.auto", kind: "approval", toolName });
      return { approved: true };
    }

    // 6. Interactive TTY prompt (only when not already requested).
    if (process.stdin?.isTTY && !state.requested) {
      const approved = await promptYesNo(`Approve tool call "${toolName}"? (y/n) `);
      if (approved) {
        await this.emit({ type: "input.auto", kind: "approval", toolName });
        return { approved: true };
      }
      await this.emit({
        type: "input.provided",
        inputRequestId,
        kind: "approval",
        approved: false,
        reason: "denied at prompt",
      });
      return { approved: false, reason: "denied at prompt" };
    }

    // 4./5. Non-interactive: request once (if not already), record the pause,
    // then park via the suspender. Replay unwinds here (throws `RunPaused`);
    // a continuation-preserving suspender (native) returns on wake, after which
    // the recorded decision is read back below.
    if (!state.requested) {
      await this.emit({ type: "input.requested", inputRequestId, kind: "approval", toolName, input });
    }
    await this.emit({ type: "run.paused", reason: "input", pendingInputIds: [inputRequestId] });
    await this.suspender.park({ runId: this.runId, inputRequestId, kind: "approval" });

    // Reached only under a continuation-preserving suspender: the resume
    // delivered a decision, now folded from the log.
    const resolved = await this.inputState(inputRequestId);
    if (resolved.resolved && resolved.approved !== undefined) {
      return resolved.approved ? { approved: true } : { approved: false, reason: resolved.reason };
    }
    return { status: "pending", inputRequestId };
  }

  /** Fold input events from the log for a specific input request id. */
  private async inputState(inputRequestId: string): Promise<{ requested: boolean; resolved: boolean; approved?: boolean; value?: unknown; reason?: string }> {
    const events = await this.store.events.read(this.runId);
    let requested = false;
    let resolved = false;
    let approved: boolean | undefined;
    let value: unknown;
    let reason: string | undefined;
    for (const e of events) {
      const p = e.payload;
      if (p.type === "input.requested" && p.inputRequestId === inputRequestId) {
        requested = true;
      } else if (p.type === "input.provided" && p.inputRequestId === inputRequestId) {
        resolved = true;
        approved = p.approved;
        value = p.value;
        reason = p.reason;
      }
    }
    return { requested, resolved, approved, value, reason };
  }

  async awaitInput(): Promise<ContentBlock[]> {
    let state = await this.nextMessageInputState();
    if (state.resolved) {
      if (this.consumedMessageInputIds.has(state.inputRequestId)) {
        const nextOrdinal = state.ordinal + 1;
        state = {
          inputRequestId: idempotencyKey(this.runId, `input:message:${nextOrdinal}`),
          requested: false,
          resolved: false,
          ordinal: nextOrdinal,
        };
      } else {
        this.consumedMessageInputIds.add(state.inputRequestId);
      }
    }
    if (state.resolved) {
      return this.messageContent(state.value);
    }
    if (!state.requested) {
      await this.emit({
        type: "input.requested",
        inputRequestId: state.inputRequestId,
        kind: "message",
        prompt: "awaiting user input",
      });
    }
    await this.emit({ type: "run.paused", reason: "input", pendingInputIds: [state.inputRequestId] });
    await this.suspender.park({ runId: this.runId, inputRequestId: state.inputRequestId, kind: "message" });

    // Continuation-preserving suspender (native) resumes here: the delivered
    // message is now in the log — re-read and return it as the awaited turn.
    const delivered = await this.nextMessageInputState();
    if (delivered.resolved) {
      return this.messageContent(delivered.value);
    }
    // A well-behaved suspender always wakes with the input resolved; guard anyway.
    throw new RunPaused(this.runId, "input", [state.inputRequestId]);
  }

  /** Coerce a resolved message-input value into model-visible content blocks. */
  private messageContent(value: unknown): ContentBlock[] {
    if (Array.isArray(value)) return value as ContentBlock[];
    const text = typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value);
    return [{ type: "text", text }];
  }

  /**
   * Determine the message-input request this await point belongs to:
   * - reuse the latest unresolved request (resume idempotency),
   * - otherwise advance to the next deterministic ordinal so multiple
   *   awaitInput() calls in one run don't reuse stale input.
   */
  private async nextMessageInputState(): Promise<{ inputRequestId: string; requested: boolean; resolved: boolean; value?: unknown; ordinal: number }> {
    const events = await this.store.events.read(this.runId);
    const requested: string[] = [];
    const byId = new Map<string, { resolved: boolean; value?: unknown }>();

    for (const e of events) {
      const p = e.payload;
      if (p.type === "input.requested" && p.kind === "message") {
        requested.push(p.inputRequestId);
        byId.set(p.inputRequestId, { resolved: false });
        continue;
      }
      if (p.type === "input.provided") {
        const row = byId.get(p.inputRequestId);
        if (!row) continue;
        row.resolved = true;
        row.value = p.value;
      }
    }

    for (let i = requested.length - 1; i >= 0; i--) {
      const inputRequestId = requested[i];
      const state = byId.get(inputRequestId);
      if (!state) continue;
      if (!state.resolved) {
        return { inputRequestId, requested: true, resolved: false, ordinal: i };
      }
      // Latest request is resolved: this awaitInput() should return it now.
      if (i === requested.length - 1) {
        return {
          inputRequestId,
          requested: true,
          resolved: true,
          value: state.value,
          ordinal: i,
        };
      }
      break;
    }

    const ordinal = requested.length;
    return {
      inputRequestId: idempotencyKey(this.runId, `input:message:${ordinal}`),
      requested: false,
      resolved: false,
      ordinal,
    };
  }

  // --- Span Correlation ---

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
