import { useState } from "react";
import { client } from "../api/client";
import { useAsync } from "../hooks/useAsync";
import { navigate } from "../state/router";
import { relativeTime, pretty } from "../lib/format";
import { ErrorBanner, Empty, Spinner, Select, SectionHeader } from "../components/ui";
import { useToast } from "../components/Toaster";
import type { ScheduleRecord, WorkflowInfo } from "../api/types";

export function SchedulesView() {
  const toast = useToast();
  const { data, error, loading, reload } = useAsync(() => client.listSchedules(), []);
  const { data: wfData } = useAsync(() => client.listWorkflows().catch(() => ({ workflows: [] as WorkflowInfo[] })), []);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  const workflows = wfData?.workflows ?? [];

  async function toggle(s: ScheduleRecord) {
    try {
      await client.updateSchedule(s.id, { enabled: !s.enabled });
      reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e), "Toggle failed");
    }
  }

  async function runNow(s: ScheduleRecord) {
    try {
      const run = await client.dispatchWorkflow(s.workflow, s.input ?? {}, "ui");
      navigate(`runs/${run.id}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e), "Dispatch failed");
    }
  }

  async function remove(s: ScheduleRecord) {
    if (!confirm(`Delete the schedule for "${s.workflow}"?`)) return;
    try {
      await client.deleteSchedule(s.id);
      toast.info("Schedule deleted");
      reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e), "Delete failed");
    }
  }

  return (
    <div className="panel">
      <SectionHeader title="Schedules" sub="Cron-triggered workflow dispatches (Lane A)">
        <button className="ghost" aria-label="Reload" onClick={reload}>{loading ? <Spinner /> : "↻"}</button>
        <button className="primary" onClick={() => { setCreating((c) => !c); setEditing(null); }}>
          {creating ? "Cancel" : "+ New schedule"}
        </button>
      </SectionHeader>

      <ErrorBanner error={error} />

      {creating && (
        <ScheduleForm
          workflows={workflows}
          onCancel={() => setCreating(false)}
          onSubmit={async (form) => {
            await client.createSchedule(form);
            toast.info("Schedule created");
            setCreating(false);
            reload();
          }}
        />
      )}

      {(data?.schedules.length ?? 0) === 0 && !loading && !creating ? (
        <Empty>No schedules configured. Create one to run a workflow on a cron.</Empty>
      ) : (
        <table>
          <thead>
            <tr><th>Workflow</th><th>Cron</th><th>Enabled</th><th>Last run</th><th></th></tr>
          </thead>
          <tbody>
            {data?.schedules.map((s) => (
              editing === s.id ? (
                <tr key={s.id}>
                  <td colSpan={5}>
                    <ScheduleForm
                      workflows={workflows}
                      initial={s}
                      onCancel={() => setEditing(null)}
                      onSubmit={async (form) => {
                        await client.updateSchedule(s.id, form);
                        toast.info("Schedule updated");
                        setEditing(null);
                        reload();
                      }}
                    />
                  </td>
                </tr>
              ) : (
                <tr key={s.id} style={{ cursor: "default" }}>
                  <td>{s.workflow}</td>
                  <td className="mono">{s.cronExpression}</td>
                  <td><span className={`pill ${s.enabled ? "s-completed" : "s-cancelled"}`}>{s.enabled ? "on" : "off"}</span></td>
                  <td className="muted">
                    {s.lastRunId
                      ? <a href={`#/runs/${s.lastRunId}`} onClick={(e) => { e.preventDefault(); navigate(`runs/${s.lastRunId}`); }}>{relativeTime(s.lastRunAt)}</a>
                      : "—"}
                  </td>
                  <td>
                    <div className="row" style={{ justifyContent: "flex-end" }}>
                      <button className="ghost" onClick={() => { setEditing(s.id); setCreating(false); }}>edit</button>
                      <button className="ghost" onClick={() => toggle(s)}>{s.enabled ? "disable" : "enable"}</button>
                      <button className="ghost" onClick={() => runNow(s)}>run now</button>
                      <button className="ghost danger" onClick={() => remove(s)}>delete</button>
                    </div>
                  </td>
                </tr>
              )
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

interface FormValues { workflow: string; cronExpression: string; input?: unknown; enabled?: boolean }

function ScheduleForm({
  workflows, initial, onCancel, onSubmit,
}: {
  workflows: WorkflowInfo[];
  initial?: ScheduleRecord;
  onCancel: () => void;
  onSubmit: (form: FormValues) => Promise<void>;
}) {
  const [workflow, setWorkflow] = useState(initial?.workflow ?? workflows[0]?.name ?? "");
  const [cron, setCron] = useState(initial?.cronExpression ?? "0 * * * *");
  const [inputText, setInputText] = useState(initial?.input !== undefined ? pretty(initial.input) : "{}");
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Workflow names may not be enumerable (no /workflows) — fall back to free text.
  const hasList = workflows.length > 0;

  async function submit() {
    setErr(null);
    let input: unknown = undefined;
    const trimmed = inputText.trim();
    if (trimmed) {
      try { input = JSON.parse(trimmed); }
      catch { setErr("Input must be valid JSON."); return; }
    }
    if (!workflow.trim()) { setErr("Workflow is required."); return; }
    if (!cron.trim()) { setErr("Cron expression is required."); return; }
    setBusy(true);
    try {
      await onSubmit({ workflow: workflow.trim(), cronExpression: cron.trim(), input, enabled });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="form-card">
      <ErrorBanner error={err} />
      <div className="form-row">
        <label>Workflow</label>
        {hasList ? (
          <Select
            value={workflow}
            onChange={(e) => setWorkflow(e.target.value)}
            options={workflows.map((w) => ({ value: w.name, label: w.name }))}
          />
        ) : (
          <input value={workflow} placeholder="workflow name" onChange={(e) => setWorkflow(e.target.value)} />
        )}
      </div>
      <div className="form-row">
        <label>Cron</label>
        <input className="mono" value={cron} placeholder="0 * * * *" onChange={(e) => setCron(e.target.value)} />
        <span className="faint">min hour dom month dow</span>
      </div>
      <div className="form-row">
        <label>Input (JSON)</label>
        <textarea className="mono" rows={4} value={inputText} onChange={(e) => setInputText(e.target.value)} />
      </div>
      <div className="form-row">
        <label>Enabled</label>
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
      </div>
      <div className="row" style={{ justifyContent: "flex-end", gap: "0.5rem" }}>
        <button className="ghost" onClick={onCancel}>Cancel</button>
        <button className="primary" disabled={busy} onClick={submit}>{busy ? <Spinner /> : initial ? "Save" : "Create"}</button>
      </div>
    </div>
  );
}
