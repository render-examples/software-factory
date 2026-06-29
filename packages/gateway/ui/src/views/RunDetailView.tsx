import { useEffect, useMemo, useState } from "react";
import { client } from "../api/client";
import { openSSE } from "../api/sse";
import { useAsync } from "../hooks/useAsync";
import { navigate, type Route } from "../state/router";
import { perAgentCost } from "../lib/trace";
import { formatCost, formatDuration, pretty } from "../lib/format";
import { StatusBadge, ErrorBanner, Spinner, CopyButton } from "../components/ui";
import { TraceView } from "../components/Trace";
import { ApprovalCard } from "../components/ApprovalCard";
import { EventLog } from "./EventLog";
import { Messages } from "./Messages";
import type { Approval } from "../api/types";

type Lens = "trace" | "events" | "messages";
const TERMINAL = new Set(["completed", "failed", "cancelled"]);

export function RunDetailView({ route }: { route: Route }) {
  const runId = route.segments[1];
  const lens = (route.query.get("lens") as Lens) ?? "trace";
  const [reloadKey, setReloadKey] = useState(0);

  const { data: run, error, loading } = useAsync(() => client.getRun(runId!), [runId, reloadKey]);
  const { data: spanData } = useAsync(() => client.getSpans(runId!), [runId, reloadKey]);
  const { data: pending, reload: reloadApprovals } = useAsync(
    () => client.listApprovals("pending"),
    [runId, reloadKey],
  );

  const live = run ? !TERMINAL.has(run.status) : false;

  // Live tail: bump reloadKey (debounced) so all lenses + header refresh.
  useEffect(() => {
    if (!runId || !live) return;
    let timer: ReturnType<typeof setTimeout>;
    const close = openSSE(`/runs/${runId}/stream`, () => {
      clearTimeout(timer);
      timer = setTimeout(() => setReloadKey((k) => k + 1), 250);
    });
    return () => { clearTimeout(timer); close(); };
  }, [runId, live]);

  const agentCosts = useMemo(() => perAgentCost(spanData?.spans ?? []), [spanData]);
  const runApprovals: Approval[] = (pending?.approvals ?? []).filter((a) => a.runId === runId);

  if (!runId) return <div className="panel">No run selected.</div>;
  if (loading && !run) return <div className="panel"><Spinner /> loading run…</div>;
  if (error) return <div className="panel"><ErrorBanner error={error} /></div>;
  if (!run) return <div className="panel">Run not found.</div>;

  const setLens = (l: Lens) => navigate(`runs/${runId}?lens=${l}`);

  return (
    <div>
      <div className="panel" style={{ paddingBottom: 0 }}>
        <div className="row wrap" style={{ marginBottom: 8 }}>
          <h3 style={{ margin: 0 }}>{run.workflow}</h3>
          <StatusBadge status={run.status} />
          {live && <span className="live-tag">● live</span>}
          <span className="spacer" />
          <CopyButton text={run.id} label="copy id" />
          {live && <button className="danger" onClick={() => client.cancelRun(runId).then(() => setReloadKey((k) => k + 1))}>Cancel</button>}
        </div>

        <div className="kvs" style={{ marginBottom: 10 }}>
          <Kv k="run id" v={<span className="mono">{run.id.slice(0, 18)}…</span>} />
          <Kv k="trigger" v={run.trigger ?? "—"} />
          <Kv k="all-in cost" v={formatCost(run.aggregateCostUsd)} />
          <Kv k="this run" v={formatCost(run.totalCostUsd)} />
          <Kv k="duration" v={formatDuration(run.startedAt, run.finishedAt)} />
          {run.userId && <Kv k="user" v={run.userId} />}
          {run.threadId && <Kv k="thread" v={<a href={`#/chat/${run.threadId}`} onClick={(e) => { e.preventDefault(); navigate(`chat/${run.threadId}`); }}>{run.threadId.slice(0, 8)}</a>} />}
        </div>

        {Object.keys(agentCosts).length > 0 && (
          <div className="row wrap" style={{ gap: "1rem", marginBottom: 10 }}>
            {Object.entries(agentCosts).map(([a, c]) => (
              <span key={a} className="chip">{a}: {formatCost(c)}</span>
            ))}
          </div>
        )}

        {run.error && <div className="banner">{run.error}</div>}

        {runApprovals.length > 0 && (
          <div style={{ marginBottom: 10 }}>
            {runApprovals.map((a) => (
              <ApprovalCard key={a.id} approval={a} showRunLink={false} onResolved={() => { reloadApprovals(); setReloadKey((k) => k + 1); }} />
            ))}
          </div>
        )}

        <div className="seg">
          <button className={lens === "trace" ? "on" : ""} onClick={() => setLens("trace")}>Trace</button>
          <button className={lens === "events" ? "on" : ""} onClick={() => setLens("events")}>Events</button>
          <button className={lens === "messages" ? "on" : ""} onClick={() => setLens("messages")}>Messages</button>
          {run.threadId && <button onClick={() => navigate(`chat/${run.threadId}`)}>Chat ↗</button>}
        </div>
      </div>

      {lens === "trace" && <div className="panel" style={{ paddingTop: 8 }}><TraceView runId={runId} reloadKey={reloadKey} /></div>}
      {lens === "events" && <EventLog runId={runId} reloadKey={reloadKey} />}
      {lens === "messages" && <Messages runId={runId} reloadKey={reloadKey} />}

      {run.result !== undefined && run.result !== null && lens === "trace" && (
        <div className="panel" style={{ paddingTop: 0 }}>
          <div className="faint">result</div>
          <pre className="json">{pretty(run.result)}</pre>
        </div>
      )}
    </div>
  );
}

function Kv({ k, v }: { k: string; v: React.ReactNode }) {
  return <div className="kv"><span className="k">{k}</span><span className="v">{v}</span></div>;
}
