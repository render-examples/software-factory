import { useState } from "react";
import { client } from "../api/client";
import { useAsync } from "../hooks/useAsync";
import { ErrorBanner, Spinner, SectionHeader } from "../components/ui";
import { useToast } from "../components/Toaster";
import type { JobStatus } from "../api/types";

const JOB_ORDER: JobStatus[] = ["queued", "running", "done", "failed", "dead"];

// Operational surface for the platform's maintenance endpoints: chat-lane queue
// depth (Lane B), the stranded-run reaper (E6), and event/run retention. Each
// action maps to an existing authed admin route.
export function OpsView() {
  const toast = useToast();
  const { data, error, loading, reload } = useAsync(() => client.adminJobs(), []);
  const [reaping, setReaping] = useState(false);
  const [retaining, setRetaining] = useState(false);

  async function reap() {
    setReaping(true);
    try {
      const r = await client.reapRuns();
      toast.info(r.reaped > 0 ? `Reaped ${r.reaped} stranded run(s)` : "No stranded runs found");
      reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e), "Reap failed");
    } finally {
      setReaping(false);
    }
  }

  async function retention() {
    if (!confirm("Run retention now? This trims old events and deletes expired run summaries.")) return;
    setRetaining(true);
    try {
      const r = await client.runRetention();
      toast.info(`Trimmed ${r.eventDetailTrimmed} event set(s), deleted ${r.runsDeleted} run(s)`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e), "Retention failed");
    } finally {
      setRetaining(false);
    }
  }

  const counts = data?.counts;

  return (
    <div className="panel">
      <SectionHeader title="Ops" sub="Chat-queue depth, stranded-run reaper, and retention">
        <button className="ghost" aria-label="Reload" onClick={reload}>{loading ? <Spinner /> : "↻"}</button>
      </SectionHeader>
      <ErrorBanner error={error} />

      <h3>Chat queue (Lane B)</h3>
      <div className="stat-grid">
        {JOB_ORDER.map((s) => (
          <div className="stat-tile" key={s}>
            <div className="stat-num">{counts ? counts[s] : "—"}</div>
            <div className="stat-label">{s}</div>
          </div>
        ))}
        <div className="stat-tile">
          <div className="stat-num">{data ? data.backlog : "—"}</div>
          <div className="stat-label">backlog</div>
        </div>
      </div>

      <h3 style={{ marginTop: "1.4rem" }}>Maintenance</h3>
      <div className="form-card">
        <div className="form-row">
          <label>Reaper</label>
          <span className="muted grow">Fail Lane A roots stranded in a non-terminal state (host died / task lost).</span>
          <button className="ghost" disabled={reaping} onClick={reap}>{reaping ? <Spinner /> : "Run reaper"}</button>
        </div>
        <div className="form-row">
          <label>Retention</label>
          <span className="muted grow">Trim old event detail and delete expired run summaries.</span>
          <button className="ghost" disabled={retaining} onClick={retention}>{retaining ? <Spinner /> : "Run retention"}</button>
        </div>
      </div>
    </div>
  );
}
