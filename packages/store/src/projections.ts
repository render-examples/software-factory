import type { RunEventRecord, ToolResult } from "./events.js";
import type { Message } from "./messages.js";
import type { RunRecord, SpanRecord, ListRunsOptions } from "./run-store.js";

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

/**
 * The projection-fold framework. Every read model (runs, messages, spans,
 * tool-calls, steps, approvals) is a pure fold of the append-only event log.
 * `apply` is the only mutation; no projection is ever written directly.
 */
export class Projections {
  private runs = new Map<string, RunRecord>();
  private messages = new Map<string, MessageEntry[]>();
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
        break;
      case "message.assistant":
        push(p.agentName, { role: "assistant", content: p.content });
        break;
      case "message.tool":
        push(p.agentName, { role: "tool", content: p.content });
        break;
    }
  }

  private foldSpans(rec: RunEventRecord): void {
    const spanId = rec.spanId;
    if (!spanId) return;
    const runSpans = this.spans.get(rec.runId) ?? new Map<string, SpanRecord>();
    this.spans.set(rec.runId, runSpans);
    const p = rec.payload;

    const open = (kind: SpanRecord["kind"], name: string, input: unknown) => {
      runSpans.set(spanId, {
        id: spanId,
        runId: rec.runId,
        parentId: rec.parentSpanId,
        seq: rec.seq,
        name,
        kind,
        status: "running",
        input,
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
        open("agent", rec.agentName ?? "run", p.input);
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
        open("tool", p.name, p.input);
        break;
      case "tool.result":
        close(p.result.isError ? { ok: false, error: p.result.content } : { ok: true, output: p.result.content });
        break;
      case "step.started":
        open("step", p.name, undefined);
        break;
      case "step.completed":
        close({ ok: true, output: p.result });
        break;
      case "llm.call":
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
          attributes: { usage: p.usage, costUsd: p.costUsd, stopReason: p.stopReason, latencyMs: p.latencyMs },
        });
        break;
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
    rows.sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
    if (opts?.before) {
      const idx = rows.findIndex(r => r.id === opts.before);
      if (idx >= 0) rows = rows.slice(idx + 1);
    }
    if (opts?.limit !== undefined) rows = rows.slice(0, opts.limit);
    return rows.map(r => ({ ...r }));
  }

  getMessages(runId: string, agentName: string): Message[] {
    const arr = this.messages.get(runId) ?? [];
    return [...arr]
      .sort((a, b) => a.seq - b.seq)
      .filter(e => e.agentName === undefined || e.agentName === agentName)
      .map(e => e.message);
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
