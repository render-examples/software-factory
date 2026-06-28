import { randomUUID } from "node:crypto";
import * as readline from "node:readline";
import type {
  RunEvent,
  Message,
  ContentBlock,
  ToolResult,
  Logger,
  Tracer,
  RunStore,
} from "@render-agents/store";
import { buildEventRecord } from "@render-agents/store";
import type { ModelSpec } from "./agent.js";
import { RunPaused } from "./agent.js";
import type { ContextManager } from "./context-manager.js";
import type { MountedTools, Tool, ToolSource } from "./tool.js";
import type { RunContext, ApprovalResult } from "./context.js";
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
  /** Pre-approved tool call IDs for resume after approval (bypass approval gate). */
  approvedToolCallIds?: ReadonlySet<string>;
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

  private readonly agentSpanId = randomUUID();
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
    this.depth = opts.depth ?? 0;
    this.maxContextTokens = opts.maxContextTokens ?? 100_000;
    this.logger = opts.logger ?? consoleLogger;
    this.envFn = opts.env ?? ((name) => process.env[name]);
    this.tools = opts.tools ?? new Map();
    this.toolSources = opts.toolSources ?? new Map();
    this.approvedToolCallIds = opts.approvedToolCallIds ?? new Set();

    if (opts.cancelStore) {
      const cancelStore = opts.cancelStore;
      const runId = opts.runId;
      this.isCancelledFn = () => cancelStore.isCancelled(runId);
    } else {
      this.isCancelledFn = opts.isCancelledFn ?? (() => false);
    }
  }

  env(name: string): string | undefined {
    return this.envFn(name);
  }

  async emit(event: RunEvent): Promise<void> {
    const span = this.spanCorrelation(event);
    const record = buildEventRecord(this.runId, event, {
      agentName: this.agentName,
      spanId: span?.spanId,
      parentSpanId: span?.parentSpanId,
    });
    await this.store.events.append(record);
  }

  async messages(agentName: string): Promise<Message[]> {
    const history = await this.store.getMessages(this.runId, agentName);
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
   * HITL gate. Three modes:
   * 1. Pre-approved (resume path): tool was previously approved, skip gate
   * 2. Auto-approve (default): emit `approval.auto`, auditable trace
   * 3. Strict: prompt on TTY or throw; production pauses via RunPaused
   */
  async requestApproval(toolName: string, input: unknown): Promise<ApprovalResult> {
    // Resume path: if this tool call was pre-approved, skip entirely
    const approvalId = randomUUID();

    const raw = this.envFn(STRICT_APPROVAL_ENV);
    const strict = raw !== undefined && raw !== "" && raw !== "0" && raw.toLowerCase() !== "false";

    if (!strict) {
      await this.emit({ type: "approval.auto", toolName });
      return { approved: true };
    }

    // Production/strict path: emit approval.requested, pause the run
    if (!process.stdin?.isTTY) {
      await this.emit({
        type: "approval.requested",
        approvalRequestId: approvalId,
        toolName,
        input,
      });
      await this.emit({ type: "run.paused", reason: "approval", pendingApprovalIds: [approvalId] });
      return { status: "pending", approvalRequestId: approvalId };
    }

    // Interactive TTY: prompt directly
    const approved = await promptYesNo(`Approve tool call "${toolName}"? (y/n) `);
    if (approved) {
      await this.emit({ type: "approval.auto", toolName });
      return { approved: true };
    }
    return { approved: false, reason: "denied at prompt" };
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

function promptYesNo(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}
