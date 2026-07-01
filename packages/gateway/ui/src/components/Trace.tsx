import { useMemo, useState } from "react";
import { client } from "../api/client";
import { useAsync } from "../hooks/useAsync";
import { buildSpanTree, spanCostUsd, type SpanNode } from "../lib/trace";
import { formatCost, formatDuration, pretty } from "../lib/format";
import type { RunEventRecord, RunRecord, SpanRecord } from "../api/types";
import { Json, Spinner, ErrorBanner } from "./ui";

interface ToolIO { input?: unknown; result?: unknown; isError?: boolean }

interface TraceData {
  tree: SpanNode[];
  toolIO: Map<string, ToolIO>;
  /** Cross-run children keyed by the parent span they hang off. */
  childRunsBySpanId: Map<string, string[]>;
  /** Children whose parent span isn't in this run's tree (rendered at root). */
  orphanRunIds: string[];
}

function deriveTrace(spans: SpanRecord[], events: RunEventRecord[], children: RunRecord[]): TraceData {
  const toolIO = new Map<string, ToolIO>();
  const callIdToSpanId = new Map<string, string>();
  const childRunsBySpanId = new Map<string, string[]>();
  const seen = new Set<string>();

  const link = (spanId: string | undefined, runId: string | undefined) => {
    if (!spanId || !runId || seen.has(runId)) return;
    seen.add(runId);
    const arr = childRunsBySpanId.get(spanId) ?? [];
    arr.push(runId);
    childRunsBySpanId.set(spanId, arr);
  };

  // Authoritative cross-run links: workflow `.task()`/`.run()` fan-out plus
  // subagents. The workflow/agent root span shares the run id, so fan-out
  // children (parentSpanId === parentRunId) attach to the root span.
  for (const c of children) link(c.parentSpanId, c.id);

  for (const e of events) {
    const p = e.payload;
    if (p.type === "tool.called") {
      if (e.spanId) {
        callIdToSpanId.set(String(p.toolCallId), e.spanId);
        const io = toolIO.get(e.spanId) ?? {};
        io.input = p.input;
        toolIO.set(e.spanId, io);
      }
    } else if (p.type === "tool.result") {
      if (e.spanId) {
        const io = toolIO.get(e.spanId) ?? {};
        const result = p.result as { content?: unknown; isError?: boolean } | undefined;
        io.result = result?.content;
        io.isError = result?.isError;
        toolIO.set(e.spanId, io);
      }
    } else if (p.type === "subagent.spawned") {
      // Fallback for older runs where the child summary wasn't captured.
      link(callIdToSpanId.get(String(p.toolCallId)), String(p.childRunId));
    }
  }

  // Any child whose parent span isn't part of this run's span tree still gets
  // shown (attached at the root) rather than silently dropped.
  const spanIds = new Set(spans.map((s) => s.id));
  const orphanRunIds: string[] = [];
  for (const [spanId, runIds] of childRunsBySpanId) {
    if (!spanIds.has(spanId)) orphanRunIds.push(...runIds);
  }

  return { tree: buildSpanTree(spans), toolIO, childRunsBySpanId, orphanRunIds };
}

function NodeMeta({ span }: { span: SpanNode }) {
  const a = span.attributes ?? {};
  if (span.kind === "llm") {
    const usage = a.usage as { inputTokens?: number; outputTokens?: number } | undefined;
    return (
      <span className="tmeta">
        {String(a.model ?? "")} · {usage?.inputTokens ?? 0}/{usage?.outputTokens ?? 0} tok
        {a.stopReason ? ` · ${a.stopReason}` : ""}
        {spanCostUsd(span) ? ` · ${formatCost(spanCostUsd(span))}` : ""}
        {a.latencyMs ? ` · ${a.latencyMs}ms` : ""}
      </span>
    );
  }
  if (span.kind === "tool") {
    return <span className="tmeta">{a.ok === false ? "error" : "ok"}{a.latencyMs ? ` · ${a.latencyMs}ms` : ""}</span>;
  }
  return null;
}

function SpanNodeView({
  span, toolIO, childRunsBySpanId, defaultOpen, reloadKey = 0,
}: {
  span: SpanNode;
  toolIO: Map<string, ToolIO>;
  childRunsBySpanId: Map<string, string[]>;
  defaultOpen: boolean;
  reloadKey?: number;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const childRunIds = childRunsBySpanId.get(span.id) ?? [];
  const io = toolIO.get(span.id);
  const hasDetail = span.children.length > 0 || !!io || childRunIds.length > 0 || !!span.error || span.output !== undefined;
  const startOpen = span.kind === "agent" || span.kind === "workflow";

  return (
    <div className="tnode">
      <div className="tline" style={{ paddingLeft: `${span.depth * 16 + 6}px` }} onClick={() => hasDetail && setOpen(!open)}>
        <span className="caret">{hasDetail ? (open ? "▾" : "▸") : ""}</span>
        <span className={`pill kind`}>{span.kind}</span>
        <span className={`tname ${span.status === "error" ? "err-text" : ""}`}>{span.name}</span>
        <span className={`pill s-${span.status}`} style={{ transform: "scale(0.85)" }}>{span.status}</span>
        <span className="tmeta">{formatDuration(span.startedAt, span.finishedAt)}</span>
        <NodeMeta span={span} />
      </div>

      {open && (
        <>
          {span.error && <div className="detail err-text">{span.error}</div>}
          {io && (
            <div className="detail" style={{ paddingLeft: `${span.depth * 16 + 22}px` }}>
              <div className="faint">input</div>
              <Json value={io.input} />
              <div className="faint">output{io.isError ? " (error)" : ""}</div>
              <Json value={typeof io.result === "string" ? io.result : pretty(io.result)} />
            </div>
          )}
          {childRunIds.map((childRunId) => (
            <div key={childRunId} className="detail" style={{ paddingLeft: `${span.depth * 16 + 22}px` }}>
              <div className="faint">child run · {childRunId.slice(0, 8)}</div>
              <TraceView runId={childRunId} depthOffset={span.depth + 1} reloadKey={reloadKey} />
            </div>
          ))}
          {span.children.map((c) => (
            <SpanNodeView key={c.id} span={c} toolIO={toolIO} childRunsBySpanId={childRunsBySpanId} defaultOpen={startOpen} reloadKey={reloadKey} />
          ))}
        </>
      )}
    </div>
  );
}

/**
 * The span/trace tree for one run. Loads spans + raw events (tool I/O) + child
 * runs, and stitches child runs (workflow `.task()`/`.run()` fan-out and LLM
 * subagents) under the parent span they hang off — recursing into each child's
 * own trace. `reloadKey` forces a refetch (keeps a live run's tree fresh).
 */
export function TraceView({ runId, reloadKey = 0, depthOffset = 0 }: { runId: string; reloadKey?: number; depthOffset?: number }) {
  const { data, error, loading } = useAsync(
    () => Promise.all([
      client.getSpans(runId),
      client.getRunEvents(runId),
      client.listRunChildren(runId).catch(() => ({ runs: [] as RunRecord[] })),
    ]),
    [runId, reloadKey],
  );

  const derived = useMemo<TraceData | null>(() => {
    if (!data) return null;
    const [{ spans }, { events }, { runs: children }] = data;
    const t = deriveTrace(spans, events, children);
    if (depthOffset) for (const r of t.tree) shiftDepth(r, depthOffset);
    return t;
  }, [data, depthOffset]);

  if (loading && !derived) return <div className="panel"><Spinner /> loading trace…</div>;
  if (error) return <ErrorBanner error={error} />;
  if (!derived || derived.tree.length === 0) return <div className="empty">No spans yet.</div>;

  return (
    <div className="tree">
      {derived.tree.map((n) => (
        <SpanNodeView key={n.id} span={n} toolIO={derived.toolIO} childRunsBySpanId={derived.childRunsBySpanId} defaultOpen reloadKey={reloadKey} />
      ))}
      {derived.orphanRunIds.map((childRunId) => (
        <div key={childRunId} className="detail" style={{ paddingLeft: `${depthOffset * 16 + 22}px` }}>
          <div className="faint">child run · {childRunId.slice(0, 8)}</div>
          <TraceView runId={childRunId} depthOffset={depthOffset + 1} reloadKey={reloadKey} />
        </div>
      ))}
    </div>
  );
}

function shiftDepth(node: SpanNode, by: number): void {
  node.depth += by;
  for (const c of node.children) shiftDepth(c, by);
}
