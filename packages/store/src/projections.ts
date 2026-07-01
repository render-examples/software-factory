import type { RunEventRecord, ToolResult, ContentBlock } from "./events.js";
import type { Message } from "./messages.js";
import type { RunRecord, SpanRecord, ListRunsOptions } from "./run-store.js";
import type { ThreadMessage } from "./thread-store.js";

/**
 * A folded approval record. Not part of the public `RunStore` read surface in
 * Wave 0 (the gateway consumes it later), but maintained here so the log stays
 * the single source of truth for approval state.
 */
export interface ApprovalProjectionRecord {
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

interface MessageEntry {
  seq: number;
  agentName?: string;
  message: Message;
}

/** A plain snapshot of every projection for a single run — used to prove that replay is byte-identical to incremental folding. */
export interface ProjectionSnapshot {
  run?: RunRecord;
  messages: MessageEntry[];
  spans: SpanRecord[];
  toolResults: Record<string, ToolResult>;
  steps: Record<string, unknown>;
  approvals: ApprovalProjectionRecord[];
}

function round(n: number): number {
  // Keep cost folds free of binary-float drift so test equality is stable.
  return Math.round(n * 1e12) / 1e12;
}

/** Flatten content blocks to plain text for the human-facing transcript. */
function flattenContent(content: ContentBlock[]): string {
  return content
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

/**
 * The projection-fold framework. Every read model (runs, messages, spans,
 * tool-calls, steps, approvals) is a pure fold of the append-only event log.
 * `apply` is the only mutation; no projection is ever written directly.
 */
export class Projections {
  private runs = new Map<string, RunRecord>();
  private messages = new Map<string, MessageEntry[]>();
  /** Human-facing per-thread transcript, folded from message.* on thread-scoped runs. */
  private threadMessages = new Map<string, ThreadMessage[]>();
  private spans = new Map<string, Map<string, SpanRecord>>();
  private toolResults = new Map<string, Map<string, ToolResult>>();
  private steps = new Map<string, Map<string, { value: unknown }>>();
  private approvals = new Map<string, Map<string, ApprovalProjectionRecord>>();

  apply(rec: RunEventRecord): void {
    this.foldRuns(rec);
    this.foldMessages(rec);
    this.foldSpans(rec);
    this.foldToolCalls(rec);
    this.foldSteps(rec);
    this.foldApprovals(rec);
  }

  private ensureRun(rec: RunEventRecord): RunRecord {
    let r = this.runs.get(rec.runId);
    if (!r) {
      r = {
        id: rec.runId,
        workflow: rec.agentName ?? "",
        status: "pending",
        totalCostUsd: 0,
        startedAt: rec.ts,
      };
      this.runs.set(rec.runId, r);
    }
    return r;
  }

  private foldRuns(rec: RunEventRecord): void {
    const p = rec.payload;
    switch (p.type) {
      case "run.started": {
        const r = this.ensureRun(rec);
        r.status = "running";
        r.startedAt = rec.ts;
        r.input = p.input;
        r.trigger = p.trigger;
        if (rec.agentName) r.workflow = rec.agentName;
        if (p.agentVersion) r.agentVersion = p.agentVersion;
        if (p.threadId) r.threadId = p.threadId;
        if (p.userId) r.userId = p.userId;
        if (rec.parentSpanId) r.parentSpanId = rec.parentSpanId;
        break;
      }
      case "run.completed": {
        const r = this.ensureRun(rec);
        r.status = "completed";
        r.result = p.result;
        r.finishedAt = rec.ts;
        break;
      }
      case "run.failed": {
        const r = this.ensureRun(rec);
        r.status = "failed";
        r.error = p.error;
        r.finishedAt = rec.ts;
        break;
      }
      case "run.paused": {
        this.ensureRun(rec).status = "paused";
        break;
      }
      case "run.cancelled": {
        const r = this.ensureRun(rec);
        r.status = "cancelled";
        r.finishedAt = rec.ts;
        break;
      }
      case "llm.call": {
        const r = this.ensureRun(rec);
        r.totalCostUsd = round(r.totalCostUsd + p.costUsd);
        break;
      }
    }
  }

  private foldMessages(rec: RunEventRecord): void {
    const p = rec.payload;
    const push = (agentName: string | undefined, message: Message) => {
      const arr = this.messages.get(rec.runId) ?? [];
      arr.push({ seq: rec.seq, agentName, message });
      this.messages.set(rec.runId, arr);
    };
    switch (p.type) {
      case "message.user":
        push(undefined, { role: "user", content: p.content });
        this.pushThreadMessage(rec, "user", p.content);
        break;
      case "message.assistant":
        push(p.agentName, { role: "assistant", content: p.content });
        this.pushThreadMessage(rec, "assistant", p.content);
        break;
      case "message.tool":
        push(p.agentName, { role: "tool", content: p.content });
        break;
    }
  }

  /**
   * Append to the human-facing thread transcript when the run belongs to a
   * thread. `run.started` folds before messages (same `apply` order), so the
   * run's `threadId` is known by the time its messages arrive. The transcript
   * flattens content blocks to text and is keyed by the thread, ordered by
   * (runId, seq) — the same coordinate the Postgres `messages` table uses.
   */
  private pushThreadMessage(rec: RunEventRecord, role: "user" | "assistant", content: ContentBlock[]): void {
    const threadId = this.runs.get(rec.runId)?.threadId;
    if (!threadId) return;
    const arr = this.threadMessages.get(threadId) ?? [];
    arr.push({
      id: `${rec.runId}:${rec.seq}`,
      threadId,
      runId: rec.runId,
      seq: rec.seq,
      role,
      content: flattenContent(content),
      createdAt: rec.ts,
    });
    this.threadMessages.set(threadId, arr);
  }

  private foldSpans(rec: RunEventRecord): void {
    const spanId = rec.spanId;
    if (!spanId) return;
    const runSpans = this.spans.get(rec.runId) ?? new Map<string, SpanRecord>();
    this.spans.set(rec.runId, runSpans);
    const p = rec.payload;

    const open = (kind: SpanRecord["kind"], name: string, input: unknown, attributes?: Record<string, unknown>) => {
      runSpans.set(spanId, {
        id: spanId,
        runId: rec.runId,
        parentId: rec.parentSpanId,
        seq: rec.seq,
        name,
        kind,
        status: "running",
        input,
        attributes,
        startedAt: rec.ts,
      });
    };
    const close = (outcome: { ok: true; output: unknown } | { ok: false; error: string }) => {
      const s = runSpans.get(spanId);
      if (!s) return;
      if (outcome.ok) {
        s.status = "ok";
        s.output = outcome.output;
      } else {
        s.status = "error";
        s.error = outcome.error;
      }
      s.finishedAt = rec.ts;
    };

    switch (p.type) {
      case "run.started":
        if ((p.spanKind ?? "agent") === "workflow") {
          // Workflow root span: orchestration, not an agent invocation.
          open("workflow", rec.agentName ?? "run", p.input, { workflow: rec.agentName, trigger: p.trigger });
        } else {
          // Agent root span. `model`/`usage`/`iterations` accumulate from the
          // run's `llm.call` events (see below) for the spec's required attrs.
          open("agent", rec.agentName ?? "run", p.input, {
            agentName: rec.agentName,
            agentVersion: p.agentVersion,
            model: p.model,
            iterations: 0,
            usage: { inputTokens: 0, outputTokens: 0 },
          });
        }
        break;
      case "run.completed":
        close({ ok: true, output: p.result });
        break;
      case "run.failed":
        close({ ok: false, error: p.error });
        break;
      case "run.cancelled":
        close({ ok: false, error: "cancelled" });
        break;
      case "tool.called":
        open("tool", p.name, p.input, { toolName: p.name });
        break;
      case "tool.result": {
        const s = runSpans.get(spanId);
        if (s) {
          s.attributes = {
            ...s.attributes,
            toolName: p.name,
            ok: !p.result.isError,
            latencyMs: s.startedAt ? Date.parse(rec.ts) - Date.parse(s.startedAt) : 0,
          };
        }
        close(p.result.isError ? { ok: false, error: p.result.content } : { ok: true, output: p.result.content });
        break;
      }
      case "step.started":
        open("step", p.name, undefined, { step: p.name });
        break;
      case "step.completed":
        close({ ok: true, output: p.result });
        break;
      case "llm.call": {
        runSpans.set(spanId, {
          id: spanId,
          runId: rec.runId,
          parentId: rec.parentSpanId,
          seq: rec.seq,
          name: p.model,
          kind: "llm",
          status: "ok",
          startedAt: rec.ts,
          finishedAt: rec.ts,
          attributes: {
            usage: p.usage,
            costUsd: p.costUsd,
            stopReason: p.stopReason,
            latencyMs: p.latencyMs,
            // OTel gen_ai semantic-convention aliases for exporters.
            "gen_ai.request.model": p.model,
            "gen_ai.usage.input_tokens": p.usage.inputTokens,
            "gen_ai.usage.output_tokens": p.usage.outputTokens,
            "gen_ai.response.finish_reasons": [p.stopReason],
          },
        });
        // Accumulate model / iteration count / token usage onto the parent
        // agent span so it carries the spec's required agent-span attributes.
        const parent = rec.parentSpanId ? runSpans.get(rec.parentSpanId) : undefined;
        if (parent && parent.kind === "agent") {
          const a = (parent.attributes ?? {}) as Record<string, unknown>;
          const prevUsage = (a.usage as { inputTokens: number; outputTokens: number } | undefined) ?? { inputTokens: 0, outputTokens: 0 };
          parent.attributes = {
            ...a,
            model: a.model ?? p.model,
            iterations: ((a.iterations as number | undefined) ?? 0) + 1,
            usage: {
              inputTokens: prevUsage.inputTokens + p.usage.inputTokens,
              outputTokens: prevUsage.outputTokens + p.usage.outputTokens,
            },
          };
        }
        break;
      }
    }
  }

  private foldToolCalls(rec: RunEventRecord): void {
    const p = rec.payload;
    // Only canonical terminal `tool.result` events populate the idempotency
    // index. Provider transport placeholders ride inside `message.tool` content
    // blocks (never `tool.result` events), so they are excluded by construction.
    if (p.type !== "tool.result") return;
    const map = this.toolResults.get(rec.runId) ?? new Map<string, ToolResult>();
    map.set(p.toolCallId, p.result);
    this.toolResults.set(rec.runId, map);
  }

  private foldSteps(rec: RunEventRecord): void {
    const p = rec.payload;
    if (p.type !== "step.completed") return;
    const map = this.steps.get(rec.runId) ?? new Map<string, { value: unknown }>();
    map.set(p.name, { value: p.result });
    this.steps.set(rec.runId, map);
  }

  private foldApprovals(rec: RunEventRecord): void {
    const p = rec.payload;
    const map = this.approvals.get(rec.runId) ?? new Map<string, ApprovalProjectionRecord>();
    switch (p.type) {
      case "approval.requested":
        map.set(p.approvalRequestId, {
          approvalRequestId: p.approvalRequestId,
          runId: rec.runId,
          toolName: p.toolName,
          input: p.input,
          agentName: rec.agentName,
          status: "pending",
          requestedAt: rec.ts,
        });
        this.approvals.set(rec.runId, map);
        break;
      case "approval.resolved": {
        const a = map.get(p.approvalRequestId);
        if (a) {
          a.status = p.approved ? "approved" : "denied";
          a.resolvedAt = rec.ts;
          a.resolvedBy = p.resolvedBy;
          a.reason = p.reason;
        }
        break;
      }
    }
  }

  // --- Read surface (folded views) ---

  getRun(runId: string): RunRecord | undefined {
    const r = this.runs.get(runId);
    return r ? { ...r } : undefined;
  }

  listRuns(opts?: ListRunsOptions): RunRecord[] {
    let rows = [...this.runs.values()];
    if (opts?.workflow) rows = rows.filter(r => r.workflow === opts.workflow);
    if (opts?.status) rows = rows.filter(r => r.status === opts.status);
    if (opts?.threadId) rows = rows.filter(r => r.threadId === opts.threadId);
    if (opts?.userId) rows = rows.filter(r => r.userId === opts.userId);
    if (opts?.roots) rows = rows.filter(r => !r.parentSpanId);
    rows.sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
    if (opts?.before) {
      const idx = rows.findIndex(r => r.id === opts.before);
      if (idx >= 0) rows = rows.slice(idx + 1);
    }
    if (opts?.limit !== undefined) rows = rows.slice(0, opts.limit);
    return rows.map(r => ({ ...r }));
  }

  /** Child runs whose `parentSpanId` points at a span within `runId` (oldest first). */
  listChildRuns(runId: string): RunRecord[] {
    const spanIds = new Set(this.spans.get(runId)?.keys() ?? []);
    // The workflow/agent root span shares the run id, so `.task()`/`.run()`
    // children (parentSpanId === parentRunId) match even before spans load.
    spanIds.add(runId);
    return [...this.runs.values()]
      .filter(r => r.parentSpanId !== undefined && spanIds.has(r.parentSpanId))
      .sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0))
      .map(r => ({ ...r }));
  }

  getMessages(runId: string, agentName: string): Message[] {
    const arr = this.messages.get(runId) ?? [];
    return [...arr]
      .sort((a, b) => a.seq - b.seq)
      .filter(e => e.agentName === undefined || e.agentName === agentName)
      .map(e => e.message);
  }

  /**
   * Model-visible history folded across every run sharing `threadId` (chat lane,
   * new-run-per-turn): ordered by run start time (then run id, then seq) so the
   * current turn's run — most recently started — sorts last, preserving the
   * runner's resume/pending-tool invariants while giving multi-turn memory.
   */
  getThreadAgentMessages(threadId: string, agentName: string): Message[] {
    const runs = [...this.runs.values()]
      .filter(r => r.threadId === threadId)
      .sort((a, b) =>
        a.startedAt !== b.startedAt
          ? (a.startedAt < b.startedAt ? -1 : 1)
          : (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
    const out: Message[] = [];
    for (const run of runs) {
      const arr = [...(this.messages.get(run.id) ?? [])].sort((a, b) => a.seq - b.seq);
      for (const e of arr) {
        if (e.agentName === undefined || e.agentName === agentName) out.push(e.message);
      }
    }
    return out;
  }

  listSpans(runId: string): SpanRecord[] {
    const runSpans = this.spans.get(runId);
    if (!runSpans) return [];
    return [...runSpans.values()].sort((a, b) => a.seq - b.seq).map(s => ({ ...s }));
  }

  getStepResult(runId: string, name: string): { value: unknown } | undefined {
    const v = this.steps.get(runId)?.get(name);
    return v ? { value: v.value } : undefined;
  }

  getToolResult(runId: string, toolCallId: string): ToolResult | undefined {
    return this.toolResults.get(runId)?.get(toolCallId);
  }

  getApprovals(runId: string): ApprovalProjectionRecord[] {
    return [...(this.approvals.get(runId)?.values() ?? [])].map(a => ({ ...a }));
  }

  /**
   * The human-facing transcript for a thread, ordered chronologically by
   * (createdAt, runId, seq). With new-run-per-turn (chat lane) a thread spans
   * many runs whose ids are random UUIDs, so ordering must key on the event
   * timestamp — not the run id — to keep turns in conversational order.
   */
  getThreadMessages(threadId: string): ThreadMessage[] {
    const arr = this.threadMessages.get(threadId) ?? [];
    return [...arr]
      .sort((a, b) =>
        a.createdAt !== b.createdAt
          ? (a.createdAt < b.createdAt ? -1 : 1)
          : a.runId !== b.runId
            ? (a.runId < b.runId ? -1 : 1)
            : a.seq - b.seq,
      )
      .map(m => ({ ...m }));
  }

  /** All approvals across every run, newest request first, optional status filter. */
  listApprovals(opts?: { status?: "pending" | "approved" | "denied"; limit?: number }): ApprovalProjectionRecord[] {
    let rows: ApprovalProjectionRecord[] = [];
    for (const map of this.approvals.values()) {
      for (const a of map.values()) rows.push({ ...a });
    }
    if (opts?.status) rows = rows.filter(a => a.status === opts.status);
    rows.sort((a, b) => (a.requestedAt < b.requestedAt ? 1 : a.requestedAt > b.requestedAt ? -1 : 0));
    if (opts?.limit !== undefined) rows = rows.slice(0, opts.limit);
    return rows;
  }

  /**
   * Trim event-detail projections for a run (spans, run_messages, tool_calls,
   * steps, approvals). The human-facing thread transcript is intentionally
   * preserved (kept with the thread per the retention policy).
   */
  trimEventDetail(runId: string): void {
    this.messages.delete(runId);
    this.spans.delete(runId);
    this.toolResults.delete(runId);
    this.steps.delete(runId);
    this.approvals.delete(runId);
  }

  /** Delete a run summary (the `runs` row). */
  deleteRunSummary(runId: string): void {
    this.runs.delete(runId);
  }

  dump(runId: string): ProjectionSnapshot {
    return {
      run: this.getRun(runId),
      messages: (this.messages.get(runId) ?? []).map(e => ({ seq: e.seq, agentName: e.agentName, message: e.message })),
      spans: this.listSpans(runId),
      toolResults: Object.fromEntries(this.toolResults.get(runId) ?? new Map()),
      steps: Object.fromEntries([...(this.steps.get(runId) ?? new Map())].map(([k, v]) => [k, v.value])),
      approvals: this.getApprovals(runId),
    };
  }
}
