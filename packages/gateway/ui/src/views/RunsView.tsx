import { useEffect, useMemo, useState } from "react";
import { client } from "../api/client";
import { useAsync } from "../hooks/useAsync";
import { useApp } from "../state/app";
import { navigate, type Route } from "../state/router";
import { formatCost, formatDuration, relativeTime } from "../lib/format";
import { StatusBadge, ErrorBanner, Empty, Spinner } from "../components/ui";
import type { RunRecord } from "../api/types";

type Filter = "attention" | "live" | "all";

export function RunsView({ route }: { route: Route }) {
  const initial = (route.query.get("filter") as Filter) ?? "attention";
  const [filter, setFilter] = useState<Filter>(initial);
  const [workflow, setWorkflow] = useState("");
  const [text, setText] = useState("");
  const { lastEvent } = useApp();

  useEffect(() => { setFilter((route.query.get("filter") as Filter) ?? "attention"); }, [route.hash]);

  const { data, error, loading, reload } = useAsync(
    () => client.listRuns({ workflow: workflow || undefined, limit: 200 }),
    [workflow],
  );

  // Live: refresh the list on lifecycle events.
  useEffect(() => {
    if (lastEvent?.category === "lifecycle") {
      const t = setTimeout(reload, 300);
      return () => clearTimeout(t);
    }
  }, [lastEvent, reload]);

  const runs = useMemo(() => {
    const all = data?.runs ?? [];
    return all.filter((r) => {
      if (text && !r.id.includes(text) && !r.workflow.includes(text)) return false;
      if (filter === "attention") return r.status === "failed" || r.status === "paused";
      if (filter === "live") return r.status === "running" || r.status === "paused" || r.status === "pending";
      return true;
    });
  }, [data, filter, text]);

  const totals = useMemo(() => {
    const cost = runs.reduce((s, r) => s + (r.totalCostUsd ?? 0), 0);
    return { cost, count: runs.length, avg: runs.length ? cost / runs.length : 0 };
  }, [runs]);

  return (
    <div className="panel">
      <div className="toolbar" style={{ marginBottom: "0.75rem" }}>
        <div className="seg">
          {(["attention", "live", "all"] as Filter[]).map((f) => (
            <button key={f} className={filter === f ? "on" : ""} onClick={() => { setFilter(f); navigate(`runs?filter=${f}`); }}>
              {f === "attention" ? "Needs attention" : f === "live" ? "Live" : "All"}
            </button>
          ))}
        </div>
        <input placeholder="filter by workflow" value={workflow} onChange={(e) => setWorkflow(e.target.value)} />
        <input placeholder="find by id / name" value={text} onChange={(e) => setText(e.target.value)} />
        <button className="ghost" onClick={reload}>{loading ? <Spinner /> : "↻"}</button>
        <span className="spacer" />
        <span className="muted">
          {totals.count} runs · {formatCost(totals.cost)} total · {formatCost(totals.avg)} avg
        </span>
      </div>

      <ErrorBanner error={error} />

      {runs.length === 0 && !loading ? (
        <Empty>No runs match this filter.</Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Status</th><th>Workflow</th><th>Trigger</th>
              <th style={{ textAlign: "right" }}>Cost</th><th>Duration</th><th>Started</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => <RunRow key={r.id} run={r} />)}
          </tbody>
        </table>
      )}
    </div>
  );
}

function RunRow({ run }: { run: RunRecord }) {
  const live = run.status === "running" || run.status === "paused";
  return (
    <tr onClick={() => navigate(`runs/${run.id}`)}>
      <td>
        <StatusBadge status={run.status} />
        {run.status === "paused" && <span className="live-tag" style={{ marginLeft: 6 }}>needs action</span>}
      </td>
      <td>{run.workflow}</td>
      <td className="muted">{run.trigger ?? "—"}</td>
      <td className="num">{formatCost(run.totalCostUsd)}</td>
      <td className="mono">{live ? <span className="live-tag">running</span> : formatDuration(run.startedAt, run.finishedAt)}</td>
      <td className="muted" title={run.startedAt}>{relativeTime(run.startedAt)}</td>
    </tr>
  );
}
