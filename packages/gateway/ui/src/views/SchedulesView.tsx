import { client } from "../api/client";
import { useAsync } from "../hooks/useAsync";
import { navigate } from "../state/router";
import { relativeTime } from "../lib/format";
import { ErrorBanner, Empty, Spinner } from "../components/ui";
import type { ScheduleRecord } from "../api/types";

export function SchedulesView() {
  const { data, error, loading, reload } = useAsync(() => client.listSchedules(), []);

  async function toggle(s: ScheduleRecord) {
    await client.updateSchedule(s.id, { enabled: !s.enabled });
    reload();
  }

  async function runNow(s: ScheduleRecord) {
    try {
      const run = await client.dispatchWorkflow(s.workflow, s.input ?? {}, "ui");
      navigate(`runs/${run.id}`);
    } catch { /* surfaced elsewhere */ }
  }

  return (
    <div className="panel">
      <div className="toolbar" style={{ marginBottom: "0.75rem" }}>
        <h3 style={{ margin: 0 }}>Schedules</h3>
        <button className="ghost" onClick={reload}>{loading ? <Spinner /> : "↻"}</button>
      </div>
      <ErrorBanner error={error} />
      {(data?.schedules.length ?? 0) === 0 && !loading ? (
        <Empty>No schedules configured.</Empty>
      ) : (
        <table>
          <thead><tr><th>Workflow</th><th>Cron</th><th>Enabled</th><th>Last run</th><th></th></tr></thead>
          <tbody>
            {data?.schedules.map((s) => (
              <tr key={s.id} onClick={(e) => e.stopPropagation()} style={{ cursor: "default" }}>
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
                    <button className="ghost" onClick={() => toggle(s)}>{s.enabled ? "disable" : "enable"}</button>
                    <button className="ghost" onClick={() => runNow(s)}>run now</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
