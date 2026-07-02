import { useMemo, useState } from "react";
import { client } from "../api/client";
import { useAsync } from "../hooks/useAsync";
import { summarizeEvent, pretty } from "../lib/format";
import { ErrorBanner, Spinner, Empty, CopyButton } from "../components/ui";
import type { EventCategory, RunEventRecord } from "../api/types";

const CATS: (EventCategory | "all")[] = [
  "all", "lifecycle", "message", "tool", "model", "step", "approval", "delegation", "context",
];

interface TaggedEvent extends RunEventRecord {
  /** The run this event belongs to (root or a descendant child run). */
  ownerRunId: string;
  /** Human label for the owning run (workflow/agent name). */
  ownerLabel: string;
}

/**
 * Fetch the root run's events plus every descendant run's events (workflow
 * `.task()`/`.run()` fan-out + subagents), merged chronologically. A workflow
 * root only logs orchestration events (run.started, step.*, run.completed) — the
 * real per-step work lives in child runs, so stitching the tree is what makes the
 * Events lens actually show what happened. Bounded by a seen-set + depth cap.
 */
async function fetchTreeEvents(rootId: string): Promise<TaggedEvent[]> {
  const out: TaggedEvent[] = [];
  const seen = new Set<string>();
  async function walk(runId: string, label: string, depth: number): Promise<void> {
    if (seen.has(runId) || depth > 6) return;
    seen.add(runId);
    const [ev, kids] = await Promise.all([
      client.getRunEvents(runId).catch(() => ({ events: [] as RunEventRecord[] })),
      client.listRunChildren(runId).catch(() => ({ runs: [] })),
    ]);
    for (const e of ev.events) out.push({ ...e, ownerRunId: runId, ownerLabel: label });
    for (const c of kids.runs) await walk(c.id, c.workflow, depth + 1);
  }
  await walk(rootId, "workflow", 0);
  out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.seq - b.seq));
  return out;
}

export function EventLog({ runId, reloadKey = 0 }: { runId: string; reloadKey?: number }) {
  const [includeChildren, setIncludeChildren] = useState(true);
  const { data, error, loading } = useAsync<TaggedEvent[]>(
    () =>
      includeChildren
        ? fetchTreeEvents(runId)
        : client
            .getRunEvents(runId)
            .then((r) => r.events.map((e) => ({ ...e, ownerRunId: runId, ownerLabel: "workflow" }))),
    [runId, reloadKey, includeChildren],
  );
  const [cat, setCat] = useState<EventCategory | "all">("all");
  const [text, setText] = useState("");
  const [openKey, setOpenKey] = useState<string | null>(null);

  const events = useMemo(() => {
    const all = data ?? [];
    return all.filter((e) => {
      if (cat !== "all" && e.category !== cat) return false;
      if (text) {
        const hay = `${e.type} ${e.agentName ?? ""} ${e.ownerLabel} ${pretty(e.payload)}`.toLowerCase();
        if (!hay.includes(text.toLowerCase())) return false;
      }
      return true;
    });
  }, [data, cat, text]);

  if (loading && !data) return <div className="panel"><Spinner /> loading events…</div>;

  return (
    <div className="panel">
      <div className="toolbar" style={{ marginBottom: "0.6rem" }}>
        <div className="seg">
          {CATS.map((c) => (
            <button key={c} className={cat === c ? "on" : ""} onClick={() => setCat(c)}>{c}</button>
          ))}
        </div>
        <input placeholder="search payloads" value={text} onChange={(e) => setText(e.target.value)} />
        <label className="muted" style={{ display: "flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" }}>
          <input type="checkbox" checked={includeChildren} onChange={(e) => setIncludeChildren(e.target.checked)} />
          child runs
        </label>
        <span className="spacer" />
        <span className="muted">{events.length} events</span>
        <CopyButton text={pretty(data ?? [])} label="copy log" />
      </div>
      <ErrorBanner error={error} />
      {events.length === 0 ? <Empty>No events.</Empty> : events.map((e) => {
        const key = `${e.ownerRunId}:${e.seq}`;
        return (
          <EventRow
            key={key}
            ev={e}
            isChild={e.ownerRunId !== runId}
            open={openKey === key}
            onToggle={() => setOpenKey(openKey === key ? null : key)}
          />
        );
      })}
    </div>
  );
}

function EventRow({
  ev, isChild, open, onToggle,
}: { ev: TaggedEvent; isChild: boolean; open: boolean; onToggle: () => void }) {
  const ts = ev.ts ? new Date(ev.ts).toLocaleTimeString() : "";
  return (
    <div>
      <div className="evrow" onClick={onToggle} style={isChild ? { paddingLeft: "1.1rem" } : undefined}>
        <span className="seq">#{ev.seq}</span>
        <span className={`cat cat-${ev.category}`}>{ev.category}</span>
        <span>{ev.type}</span>
        {isChild && (
          <span className="chip" title={ev.ownerRunId}>{ev.ownerLabel} · {ev.ownerRunId.slice(0, 8)}</span>
        )}
        <span className="summary">{summarizeEvent(ev.type, ev.payload)}</span>
      </div>
      {open && (
        <div className="tnode">
          <div className="detail">
            <div className="row faint" style={{ marginBottom: 4 }}>
              <span>{ts}</span>
              <span>run={ev.ownerRunId.slice(0, 8)}</span>
              {ev.agentName && <span>agent={ev.agentName}</span>}
              {ev.spanId && <span>span={ev.spanId.slice(0, 8)}</span>}
              {ev.parentSpanId && <span>parent={ev.parentSpanId.slice(0, 8)}</span>}
              <CopyButton text={pretty(ev.payload)} label="copy json" />
            </div>
            <pre className="json">{pretty(ev.payload)}</pre>
          </div>
        </div>
      )}
    </div>
  );
}
