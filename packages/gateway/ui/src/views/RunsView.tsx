import { useCallback, useEffect, useMemo, useState } from "react";
import { client, ApiError } from "../api/client";
import { useApp } from "../state/app";
import { navigate, type Route } from "../state/router";
import { formatCost, formatDuration, relativeTime } from "../lib/format";
import { StatusBadge, ErrorBanner, Empty, Spinner, Select } from "../components/ui";
import type { RunRecord } from "../api/types";

type Filter = "attention" | "live" | "all";
type Lane = "all" | "workflow" | "chat";

const PAGE = 100;

// A run carries a threadId iff it is a Lane B chat turn; Lane A workflow roots
// don't. This is the one field that distinguishes the two execution lanes (D12).
function laneOf(r: RunRecord): Exclude<Lane, "all"> {
  return r.threadId ? "chat" : "workflow";
}

function errMsg(e: unknown): string {
  return e instanceof ApiError ? `${e.message} (${e.status})` : String((e as Error)?.message ?? e);
}

export function RunsView({ route }: { route: Route }) {
  const initial = (route.query.get("filter") as Filter) ?? "all";
  const [filter, setFilter] = useState<Filter>(initial);
  const [lane, setLane] = useState<Lane>((route.query.get("lane") as Lane) ?? "all");
  const [workflow, setWorkflow] = useState("");
  const [text, setText] = useState("");
  const { lastEvent } = useApp();

  const [runsData, setRunsData] = useState<RunRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exhausted, setExhausted] = useState(false);

  useEffect(() => {
    setFilter((route.query.get("filter") as Filter) ?? "all");
    setLane((route.query.get("lane") as Lane) ?? "all");
  }, [route.hash]);

  // First page (and refresh). Keyed on workflow so a server-side filter change
  // resets the cursor. Client-side filters (attention/live/text) operate on the
  // accumulated pages below.
  const loadFirst = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { runs } = await client.listRuns({ workflow: workflow || undefined, limit: PAGE });
      setRunsData(runs);
      setExhausted(runs.length < PAGE);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setLoading(false);
    }
  }, [workflow]);

  useEffect(() => { loadFirst(); }, [loadFirst]);

  // Live: refresh the first page on lifecycle events.
  useEffect(() => {
    if (lastEvent?.category === "lifecycle") {
      const t = setTimeout(loadFirst, 300);
      return () => clearTimeout(t);
    }
  }, [lastEvent, loadFirst]);

  const loadMore = useCallback(async () => {
    setLoadingMore(true);
    setError(null);
    try {
      const before = runsData[runsData.length - 1]?.id;
      const { runs } = await client.listRuns({ workflow: workflow || undefined, before, limit: PAGE });
      setRunsData((prev) => [...prev, ...runs]);
      setExhausted(runs.length < PAGE);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setLoadingMore(false);
    }
  }, [runsData, workflow]);

  const runs = useMemo(() => {
    return runsData.filter((r) => {
      if (text && !r.id.includes(text) && !r.workflow.includes(text)) return false;
      if (lane !== "all" && laneOf(r) !== lane) return false;
      if (filter === "attention") return r.status === "failed" || r.status === "paused";
      if (filter === "live") return r.status === "running" || r.status === "paused" || r.status === "pending";
      return true;
    });
  }, [runsData, filter, lane, text]);

  const totals = useMemo(() => {
    const cost = runs.reduce((s, r) => s + (r.totalCostUsd ?? 0), 0);
    return { cost, count: runs.length, avg: runs.length ? cost / runs.length : 0 };
  }, [runs]);

  return (
    <div className="panel">
      <div className="toolbar" style={{ marginBottom: "0.75rem" }}>
        <div className="seg" role="tablist" aria-label="Run filter">
          {(["attention", "live", "all"] as Filter[]).map((f) => (
            <button
              key={f}
              role="tab"
              aria-selected={filter === f}
              className={filter === f ? "on" : ""}
              onClick={() => { setFilter(f); navigate(`runs?filter=${f}&lane=${lane}`); }}
            >
              {f === "attention" ? "Needs attention" : f === "live" ? "Live" : "All"}
            </button>
          ))}
        </div>
        <Select
          aria-label="Filter by lane"
          value={lane}
          onChange={(e) => { const v = e.target.value as Lane; setLane(v); navigate(`runs?filter=${filter}&lane=${v}`); }}
          options={[
            { value: "all", label: "All lanes" },
            { value: "workflow", label: "Workflow" },
            { value: "chat", label: "Chat" },
          ]}
        />
        <input aria-label="Filter by workflow" placeholder="filter by workflow" value={workflow} onChange={(e) => setWorkflow(e.target.value)} />
        <input aria-label="Find by id or name" placeholder="find by id / name" value={text} onChange={(e) => setText(e.target.value)} />
        <button className="ghost" aria-label="Reload" onClick={loadFirst}>{loading ? <Spinner /> : "↻"}</button>
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
              <th>Status</th><th>Lane</th><th>Workflow</th><th>Trigger</th>
              <th style={{ textAlign: "right" }}>Cost</th><th>Duration</th><th>Started</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => <RunRow key={r.id} run={r} />)}
          </tbody>
        </table>
      )}

      {!exhausted && runsData.length > 0 && (
        <div className="row" style={{ justifyContent: "center", padding: "0.9rem" }}>
          <button className="ghost" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? <><Spinner /> loading…</> : "Load more"}
          </button>
        </div>
      )}
    </div>
  );
}

function RunRow({ run }: { run: RunRecord }) {
  const live = run.status === "running" || run.status === "paused";
  const lane = laneOf(run);
  const open = () => navigate(`runs/${run.id}`);
  return (
    <tr
      tabIndex={0}
      aria-label={`Run ${run.workflow}, ${run.status}`}
      onClick={open}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } }}
    >
      <td>
        <StatusBadge status={run.status} />
        {run.status === "paused" && <span className="live-tag" style={{ marginLeft: 6 }}>needs action</span>}
      </td>
      <td>
        <span className="chip">{lane}</span>
      </td>
      <td>
        {run.workflow}
        {lane === "chat" && run.threadId && (
          <a
            className="faint"
            style={{ marginLeft: 8 }}
            href={`#/chat/${run.threadId}`}
            onClick={(e) => { e.stopPropagation(); e.preventDefault(); navigate(`chat/${run.threadId}`); }}
          >
            open in chat ↗
          </a>
        )}
      </td>
      <td className="muted">{run.trigger ?? "—"}</td>
      <td className="num">{formatCost(run.totalCostUsd)}</td>
      <td className="mono">{live ? <span className="live-tag">running</span> : formatDuration(run.startedAt, run.finishedAt)}</td>
      <td className="muted" title={run.startedAt}>{relativeTime(run.startedAt)}</td>
    </tr>
  );
}
