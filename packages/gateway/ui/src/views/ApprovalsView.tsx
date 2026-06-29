import { useEffect, useState } from "react";
import { client } from "../api/client";
import { useAsync } from "../hooks/useAsync";
import { useApp } from "../state/app";
import { navigate } from "../state/router";
import { relativeTime, truncate, pretty } from "../lib/format";
import { ApprovalCard } from "../components/ApprovalCard";
import { ErrorBanner, Empty, Spinner } from "../components/ui";
import type { Approval } from "../api/types";

export function ApprovalsView() {
  const [tab, setTab] = useState<"pending" | "resolved">("pending");
  const { lastEvent, refreshCounts } = useApp();

  const { data, error, loading, reload } = useAsync(async () => {
    if (tab === "pending") return (await client.listApprovals("pending")).approvals;
    const [a, d] = await Promise.all([client.listApprovals("approved"), client.listApprovals("denied")]);
    return [...a.approvals, ...d.approvals].sort((x, y) => (y.resolvedAt ?? "").localeCompare(x.resolvedAt ?? ""));
  }, [tab]);

  useEffect(() => {
    if (lastEvent?.category === "approval") {
      const t = setTimeout(reload, 300);
      return () => clearTimeout(t);
    }
  }, [lastEvent, reload]);

  const onResolved = () => { reload(); refreshCounts(); };

  return (
    <div className="panel">
      <div className="toolbar" style={{ marginBottom: "0.75rem" }}>
        <div className="seg">
          <button className={tab === "pending" ? "on" : ""} onClick={() => setTab("pending")}>Pending</button>
          <button className={tab === "resolved" ? "on" : ""} onClick={() => setTab("resolved")}>Resolved</button>
        </div>
        <button className="ghost" onClick={reload}>{loading ? <Spinner /> : "↻"}</button>
        <span className="spacer" />
        <span className="muted">{data?.length ?? 0} {tab}</span>
      </div>

      <ErrorBanner error={error} />

      {(data?.length ?? 0) === 0 && !loading ? (
        <Empty>{tab === "pending" ? "Nothing awaiting approval. 🎉" : "No resolved approvals yet."}</Empty>
      ) : tab === "pending" ? (
        data!.map((a) => <ApprovalCard key={a.id} approval={a} onResolved={onResolved} />)
      ) : (
        data!.map((a) => <ResolvedRow key={a.id} approval={a} />)
      )}
    </div>
  );
}

function ResolvedRow({ approval }: { approval: Approval }) {
  return (
    <div className="card">
      <div className="row wrap">
        <span className={`pill s-${approval.status}`}>{approval.status}</span>
        <b className="mono">{approval.toolName}</b>
        <span className="chip">{approval.agentName}</span>
        <span className="spacer" />
        {approval.resolvedBy && <span className="muted">by {approval.resolvedBy}</span>}
        <span className="faint">{relativeTime(approval.resolvedAt)}</span>
        <a href={`#/runs/${approval.runId}`} onClick={(e) => { e.preventDefault(); navigate(`runs/${approval.runId}`); }}>run {approval.runId.slice(0, 8)}</a>
      </div>
      {approval.reason && <div className="muted" style={{ marginTop: 4 }}>“{approval.reason}”</div>}
      <div className="faint mono" style={{ marginTop: 4 }}>{truncate(pretty(approval.input), 100)}</div>
    </div>
  );
}
