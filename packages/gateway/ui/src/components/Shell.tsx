import { type ReactNode } from "react";
import { useApp } from "../state/app";
import { navigate, type Route } from "../state/router";
import { getKey } from "../api/auth";

const NAV = [
  { id: "runs", label: "Runs", ico: "▦" },
  { id: "approvals", label: "Approvals", ico: "⚑" },
  { id: "chat", label: "Chat", ico: "✦" },
  { id: "threads", label: "Threads", ico: "❏" },
  { id: "schedules", label: "Schedules", ico: "◷" },
];

export function Shell({ route, children }: { route: Route; children: ReactNode }) {
  const { activeRuns, pendingApprovals, operator, setOperator } = useApp();
  const top = route.segments[0] ?? "runs";

  return (
    <div className="app">
      <aside className="rail">
        <div className="brand"><b>render-agents</b><div className="muted">operator</div></div>
        <nav>
          {NAV.map((n) => (
            <a
              key={n.id}
              href={`#/${n.id}`}
              className={top === n.id ? "active" : ""}
              onClick={(e) => { e.preventDefault(); navigate(n.id); }}
            >
              <span className="ico">{n.ico}</span>
              <span>{n.label}</span>
              {n.id === "approvals" && pendingApprovals > 0 && <span className="badge">{pendingApprovals}</span>}
            </a>
          ))}
        </nav>
        <div className="footer">
          <div className="stat" onClick={() => navigate("runs?filter=live")}>
            <span className={`dot ${activeRuns > 0 ? "live" : ""}`} /> {activeRuns} active run{activeRuns === 1 ? "" : "s"}
          </div>
          <div className="stat" onClick={() => navigate("approvals")}>
            <span className={`dot ${pendingApprovals > 0 ? "wait" : ""}`} /> {pendingApprovals} awaiting approval
          </div>
        </div>
      </aside>

      <div className="main">
        <div className="topbar">
          <span className="muted nowrap">{breadcrumb(route)}</span>
          <span className="spacer" />
          <span className="faint nowrap" title="Command palette">⌘K</span>
          <input
            style={{ width: 150 }}
            value={operator}
            placeholder="operator name"
            title="Sent as resolvedBy on approvals"
            onChange={(e) => setOperator(e.target.value)}
          />
          <span className="chip" title="API key in use">key ••{getKey().slice(-3)}</span>
        </div>
        <div className="content">{children}</div>
      </div>
    </div>
  );
}

function breadcrumb(route: Route): string {
  const [a, b] = route.segments;
  if (!a) return "runs";
  if (a === "runs" && b) return `runs / ${b.slice(0, 12)}…`;
  if (a === "threads" && b) return `threads / ${b.slice(0, 12)}…`;
  if (a === "chat" && b) return `chat / ${b.slice(0, 12)}…`;
  return a;
}
