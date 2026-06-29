import { useMemo, useState } from "react";
import { client } from "../api/client";
import { useAsync } from "../hooks/useAsync";
import { summarizeEvent, pretty } from "../lib/format";
import { ErrorBanner, Spinner, Empty, CopyButton } from "../components/ui";
import type { EventCategory, RunEventRecord } from "../api/types";

const CATS: (EventCategory | "all")[] = [
  "all", "lifecycle", "message", "tool", "model", "step", "approval", "delegation", "context",
];

export function EventLog({ runId, reloadKey = 0 }: { runId: string; reloadKey?: number }) {
  const { data, error, loading } = useAsync(() => client.getRunEvents(runId), [runId, reloadKey]);
  const [cat, setCat] = useState<EventCategory | "all">("all");
  const [text, setText] = useState("");
  const [openSeq, setOpenSeq] = useState<number | null>(null);

  const events = useMemo(() => {
    const all = data?.events ?? [];
    return all.filter((e) => {
      if (cat !== "all" && e.category !== cat) return false;
      if (text) {
        const hay = `${e.type} ${e.agentName ?? ""} ${pretty(e.payload)}`.toLowerCase();
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
        <span className="spacer" />
        <span className="muted">{events.length} events</span>
        <CopyButton text={pretty(data?.events ?? [])} label="copy log" />
      </div>
      <ErrorBanner error={error} />
      {events.length === 0 ? <Empty>No events.</Empty> : events.map((e) => (
        <EventRow key={e.seq} ev={e} open={openSeq === e.seq} onToggle={() => setOpenSeq(openSeq === e.seq ? null : e.seq)} />
      ))}
    </div>
  );
}

function EventRow({ ev, open, onToggle }: { ev: RunEventRecord; open: boolean; onToggle: () => void }) {
  const ts = ev.ts ? new Date(ev.ts).toLocaleTimeString() : "";
  return (
    <div>
      <div className="evrow" onClick={onToggle}>
        <span className="seq">#{ev.seq}</span>
        <span className={`cat cat-${ev.category}`}>{ev.category}</span>
        <span>{ev.type}</span>
        <span className="summary">{summarizeEvent(ev.type, ev.payload)}</span>
      </div>
      {open && (
        <div className="tnode">
          <div className="detail">
            <div className="row faint" style={{ marginBottom: 4 }}>
              <span>{ts}</span>
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
