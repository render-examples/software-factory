import { useEffect, useState } from "react";
import { client } from "../api/client";
import { useAsync } from "../hooks/useAsync";
import { navigate, type Route } from "../state/router";
import { formatCost, formatDuration, relativeTime } from "../lib/format";
import { ErrorBanner, Empty, Spinner, Select, SectionHeader, StatusBadge } from "../components/ui";
import { useToast } from "../components/Toaster";
import type { WorkflowInfo } from "../api/types";

export function WorkflowsView({ route }: { route: Route }) {
  const toast = useToast();
  const { data, error, loading } = useAsync(() => client.listWorkflows(), []);
  const workflows = data?.workflows ?? [];
  const preselect = route.segments[1];
  const [selected, setSelected] = useState<string>(preselect ?? "");

  // Default the selection once workflows load (respecting a deep-linked name).
  useEffect(() => {
    if (!selected && workflows.length > 0) setSelected(preselect ?? workflows[0].name);
  }, [workflows, preselect, selected]);

  return (
    <div className="panel">
      <SectionHeader title="Workflows" sub="Durable pipelines (Lane A) — dispatch on demand" />
      <ErrorBanner error={error} />
      {loading && workflows.length === 0 ? (
        <div><Spinner /> loading workflows…</div>
      ) : workflows.length === 0 ? (
        <Empty>No workflows are registered on this gateway.</Empty>
      ) : (
        <>
          <DispatchForm
            workflows={workflows}
            selected={selected}
            onSelect={setSelected}
            onDispatched={(runId) => { toast.info("Workflow dispatched"); navigate(`runs/${runId}`); }}
            onError={(m) => toast.error(m, "Dispatch failed")}
          />
          {selected && <WorkflowRuns workflow={selected} />}
        </>
      )}
    </div>
  );
}

function DispatchForm({
  workflows, selected, onSelect, onDispatched, onError,
}: {
  workflows: WorkflowInfo[];
  selected: string;
  onSelect: (name: string) => void;
  onDispatched: (runId: string) => void;
  onError: (message: string) => void;
}) {
  const [inputText, setInputText] = useState("{}");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function dispatch() {
    setErr(null);
    let input: unknown = undefined;
    const trimmed = inputText.trim();
    if (trimmed) {
      try { input = JSON.parse(trimmed); }
      catch { setErr("Input must be valid JSON."); return; }
    }
    setBusy(true);
    try {
      const run = await client.dispatchWorkflow(selected, input ?? {}, "ui");
      onDispatched(run.id);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      setErr(m);
      onError(m);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="form-card">
      <ErrorBanner error={err} />
      <div className="form-row">
        <label>Workflow</label>
        <Select
          value={selected}
          onChange={(e) => onSelect(e.target.value)}
          options={workflows.map((w) => ({ value: w.name, label: w.name }))}
        />
      </div>
      <div className="form-row">
        <label>Input (JSON)</label>
        <textarea className="mono" rows={5} value={inputText} onChange={(e) => setInputText(e.target.value)} />
      </div>
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="primary" disabled={busy || !selected} onClick={dispatch}>{busy ? <Spinner /> : "Dispatch"}</button>
      </div>
    </div>
  );
}

function WorkflowRuns({ workflow }: { workflow: string }) {
  const { data, error, loading, reload } = useAsync(() => client.listRuns({ workflow, limit: 25 }), [workflow]);
  const runs = data?.runs ?? [];
  return (
    <div>
      <div className="row" style={{ margin: "0.5rem 0", alignItems: "center" }}>
        <h3 style={{ margin: 0 }}>Recent runs</h3>
        <span className="chip mono">{workflow}</span>
        <span className="spacer" />
        <button className="ghost" aria-label="Reload" onClick={reload}>{loading ? <Spinner /> : "↻"}</button>
      </div>
      <ErrorBanner error={error} />
      {runs.length === 0 && !loading ? (
        <Empty>No runs for this workflow yet.</Empty>
      ) : (
        <table>
          <thead><tr><th>Status</th><th>Trigger</th><th style={{ textAlign: "right" }}>Cost</th><th>Duration</th><th>Started</th></tr></thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id} onClick={() => navigate(`runs/${r.id}`)}>
                <td><StatusBadge status={r.status} /></td>
                <td className="muted">{r.trigger ?? "—"}</td>
                <td className="num">{formatCost(r.totalCostUsd)}</td>
                <td className="mono">{formatDuration(r.startedAt, r.finishedAt)}</td>
                <td className="muted" title={r.startedAt}>{relativeTime(r.startedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
