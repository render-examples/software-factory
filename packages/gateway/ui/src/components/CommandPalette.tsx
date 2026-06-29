import { useEffect, useMemo, useState } from "react";
import { navigate } from "../state/router";

interface Cmd { label: string; hint?: string; run: () => void }

/** ⌘K / Ctrl-K command palette: jump to a view or open a run by id. */
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
        setQ("");
        setSel(0);
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const commands = useMemo<Cmd[]>(() => {
    const go = (path: string): (() => void) => () => { navigate(path); setOpen(false); };
    const base: Cmd[] = [
      { label: "Runs", hint: "all runs", run: go("runs") },
      { label: "Needs attention", hint: "failed + paused", run: go("runs?filter=attention") },
      { label: "Approvals", run: go("approvals") },
      { label: "Chat", run: go("chat") },
      { label: "Threads", run: go("threads") },
      { label: "Schedules", run: go("schedules") },
    ];
    const trimmed = q.trim();
    if (trimmed && !base.some((c) => c.label.toLowerCase().includes(trimmed.toLowerCase()))) {
      base.unshift({ label: `Open run "${trimmed}"`, hint: "go to run id", run: () => { navigate(`runs/${trimmed}`); setOpen(false); } });
    }
    return base.filter((c) => c.label.toLowerCase().includes(trimmed.toLowerCase()) || trimmed === "" || c.label.startsWith("Open run"));
  }, [q]);

  if (!open) return null;

  return (
    <div className="overlay" onClick={() => setOpen(false)}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <input
          autoFocus
          placeholder="Jump to a view, or paste a run id…"
          value={q}
          onChange={(e) => { setQ(e.target.value); setSel(0); }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, commands.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
            else if (e.key === "Enter") { commands[sel]?.run(); }
          }}
        />
        {commands.map((c, i) => (
          <div key={c.label} className={`opt ${i === sel ? "sel" : ""}`} onMouseEnter={() => setSel(i)} onClick={c.run}>
            <span className="grow">{c.label}</span>
            {c.hint && <span className="faint">{c.hint}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
