import { useMemo, useState } from "react";
import { client } from "../api/client";
import { useAsync } from "../hooks/useAsync";
import { blocksToText, pretty } from "../lib/format";
import { ErrorBanner, Spinner, Empty } from "../components/ui";
import type { RunEventRecord } from "../api/types";

interface Turn {
  seq: number;
  role: "user" | "assistant" | "tool" | "compaction";
  agentName?: string;
  blocks: unknown;
  note?: string;
}

export function Messages({ runId, reloadKey = 0 }: { runId: string; reloadKey?: number }) {
  const { data, error, loading } = useAsync(() => client.getRunEvents(runId), [runId, reloadKey]);
  const [agent, setAgent] = useState<string>("all");

  const { turns, agents } = useMemo(() => {
    const evs = data?.events ?? [];
    const agentSet = new Set<string>();
    const t: Turn[] = [];
    for (const e of evs) {
      const p = e.payload as RunEventRecord["payload"];
      if (p.type === "message.user") t.push({ seq: e.seq, role: "user", blocks: p.content });
      else if (p.type === "message.assistant") { agentSet.add(String(p.agentName)); t.push({ seq: e.seq, role: "assistant", agentName: String(p.agentName), blocks: p.content }); }
      else if (p.type === "message.tool") { agentSet.add(String(p.agentName)); t.push({ seq: e.seq, role: "tool", agentName: String(p.agentName), blocks: p.content }); }
      else if (p.type === "context.compacted") t.push({ seq: e.seq, role: "compaction", agentName: String(p.agentName), blocks: null, note: `compacted (${p.strategy}): ${p.beforeTokens}→${p.afterTokens} tokens` });
    }
    return { turns: t, agents: [...agentSet] };
  }, [data]);

  const visible = turns.filter((t) => agent === "all" || t.role === "user" || t.agentName === agent);

  if (loading && !data) return <div className="panel"><Spinner /> loading messages…</div>;

  return (
    <div className="panel">
      <div className="toolbar" style={{ marginBottom: "0.6rem" }}>
        <span className="muted">Model-visible history</span>
        {agents.length > 1 && (
          <select value={agent} onChange={(e) => setAgent(e.target.value)}>
            <option value="all">all agents</option>
            {agents.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        )}
      </div>
      <ErrorBanner error={error} />
      {visible.length === 0 ? <Empty>No messages yet.</Empty> : visible.map((t) => <TurnView key={t.seq} turn={t} />)}
    </div>
  );
}

function TurnView({ turn }: { turn: Turn }) {
  if (turn.role === "compaction") {
    return <div className="card" style={{ borderStyle: "dashed", textAlign: "center" }}><span className="faint">⎯ {turn.note} ⎯</span></div>;
  }
  const text = blocksToText(turn.blocks);
  const toolBlocks = Array.isArray(turn.blocks)
    ? (turn.blocks as Array<{ type?: string }>).filter((b) => b.type === "tool_use" || b.type === "tool_result")
    : [];
  return (
    <div className="card">
      <div className="faint" style={{ marginBottom: 4 }}>
        {turn.role}{turn.agentName ? ` · ${turn.agentName}` : ""} <span className="chip">#{turn.seq}</span>
      </div>
      {text && <div style={{ whiteSpace: "pre-wrap" }}>{text}</div>}
      {toolBlocks.map((b, i) => <pre key={i} className="json" style={{ marginTop: 6 }}>{pretty(b)}</pre>)}
    </div>
  );
}
