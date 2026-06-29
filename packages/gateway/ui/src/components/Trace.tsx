import { useMemo, useState } from "react";
import { client } from "../api/client";
import { useAsync } from "../hooks/useAsync";
import { buildSpanTree, spanCostUsd, type SpanNode } from "../lib/trace";
import { formatCost, formatDuration, pretty } from "../lib/format";
import type { RunEventRecord, SpanRecord } from "../api/types";
import { Json, Spinner, ErrorBanner } from "./ui";

interface ToolIO { input?: unknown; result?: unknown; isError?: boolean }

interface TraceData {
  tree: SpanNode[];
  toolIO: Map<string, ToolIO>;
  childRunBySpanId: Map<string, string>;
}

function deriveTrace(spans: SpanRecord[], events: RunEventRecord[]): TraceData {
  const toolIO = new Map<string, ToolIO>();
  const callIdToSpanId = new Map<string, string>();
  const childRunBySpanId = new Map<string, string>();

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
      const spanId = callIdToSpanId.get(String(p.toolCallId));
      if (spanId) childRunBySpanId.set(spanId, String(p.childRunId));
    }
  }

  return { tree: buildSpanTree(spans), toolIO, childRunBySpanId };
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
  span, toolIO, childRunBySpanId, defaultOpen,
}: {
  span: SpanNode;
  toolIO: Map<string, ToolIO>;
  childRunBySpanId: Map<string, string>;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const childRunId = childRunBySpanId.get(span.id);
  const io = toolIO.get(span.id);
  const hasDetail = span.children.length > 0 || !!io || !!childRunId || !!span.error || span.output !== undefined;
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
          {childRunId && (
            <div className="detail" style={{ paddingLeft: `${span.depth * 16 + 22}px` }}>
              <div className="faint">subagent run · {childRunId.slice(0, 8)}</div>
              <TraceView runId={childRunId} depthOffset={span.depth + 1} />
            </div>
          )}
          {span.children.map((c) => (
            <SpanNodeView key={c.id} span={c} toolIO={toolIO} childRunBySpanId={childRunBySpanId} defaultOpen={startOpen} />
          ))}
        </>
      )}
    </div>
  );
}

/**
 * The span/trace tree for one run. Loads spans + raw events (events give tool
 * I/O and the subagent.spawned → childRunId mapping for cross-run stitching).
 * `reloadKey` forces a refetch (used to keep a live run's tree fresh).
 */
export function TraceView({ runId, reloadKey = 0, depthOffset = 0 }: { runId: string; reloadKey?: number; depthOffset?: number }) {
  const { data, error, loading } = useAsync(
    () => Promise.all([client.getSpans(runId), client.getRunEvents(runId)]),
    [runId, reloadKey],
  );

  const derived = useMemo<TraceData | null>(() => {
    if (!data) return null;
    const [{ spans }, { events }] = data;
    const t = deriveTrace(spans, events);
    if (depthOffset) for (const r of t.tree) shiftDepth(r, depthOffset);
    return t;
  }, [data, depthOffset]);

  if (loading && !derived) return <div className="panel"><Spinner /> loading trace…</div>;
  if (error) return <ErrorBanner error={error} />;
  if (!derived || derived.tree.length === 0) return <div className="empty">No spans yet.</div>;

  return (
    <div className="tree">
      {derived.tree.map((n) => (
        <SpanNodeView key={n.id} span={n} toolIO={derived.toolIO} childRunBySpanId={derived.childRunBySpanId} defaultOpen />
      ))}
    </div>
  );
}

function shiftDepth(node: SpanNode, by: number): void {
  node.depth += by;
  for (const c of node.children) shiftDepth(c, by);
}
