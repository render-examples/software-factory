import { useEffect, useState, type ComponentType, type ReactNode, type SVGProps } from "react";
import { useApp } from "../state/app";
import { navigate, type Route } from "../state/router";
import { getKey } from "../api/auth";
import { getTheme, nextTheme, setTheme, type ThemeChoice } from "../state/theme";
import {
  RunsIcon, ApprovalsIcon, ChatIcon, ThreadsIcon, SchedulesIcon,
  MenuIcon, SunIcon, MoonIcon, MonitorIcon,
} from "./Icons";

type IconCmp = ComponentType<SVGProps<SVGSVGElement>>;

const NAV: { id: string; label: string; Icon: IconCmp }[] = [
  { id: "runs", label: "Runs", Icon: RunsIcon },
  { id: "approvals", label: "Approvals", Icon: ApprovalsIcon },
  { id: "chat", label: "Chat", Icon: ChatIcon },
  { id: "threads", label: "Threads", Icon: ThreadsIcon },
  { id: "schedules", label: "Schedules", Icon: SchedulesIcon },
];

export function Shell({ route, children }: { route: Route; children: ReactNode }) {
  const { activeRuns, pendingApprovals, operator, setOperator } = useApp();
  const top = route.segments[0] ?? "runs";
  const [navOpen, setNavOpen] = useState(false);

  // Close the mobile nav whenever the route changes.
  useEffect(() => { setNavOpen(false); }, [route.hash]);

  const go = (id: string) => { navigate(id); setNavOpen(false); };

  return (
    <div className={`app${navOpen ? " nav-open" : ""}`}>
      <div className="scrim" onClick={() => setNavOpen(false)} aria-hidden />
      <aside className="rail" aria-label="Primary">
        <div className="brand"><b>render-agents</b><div className="muted">operator</div></div>
        <nav aria-label="Sections">
          {NAV.map(({ id, label, Icon }) => {
            const active = top === id;
            return (
              <a
                key={id}
                href={`#/${id}`}
                className={active ? "active" : ""}
                aria-current={active ? "page" : undefined}
                onClick={(e) => { e.preventDefault(); go(id); }}
              >
                <span className="ico"><Icon /></span>
                <span>{label}</span>
                {id === "approvals" && pendingApprovals > 0 && (
                  <span className="badge" aria-label={`${pendingApprovals} pending`}>{pendingApprovals}</span>
                )}
              </a>
            );
          })}
        </nav>
        <div className="footer">
          <button type="button" className="stat" onClick={() => go("runs?filter=live")}>
            <span className={`dot ${activeRuns > 0 ? "live" : ""}`} /> {activeRuns} active run{activeRuns === 1 ? "" : "s"}
          </button>
          <button type="button" className="stat" onClick={() => go("approvals")}>
            <span className={`dot ${pendingApprovals > 0 ? "wait" : ""}`} /> {pendingApprovals} awaiting approval
          </button>
        </div>
      </aside>

      <div className="main">
        <div className="topbar">
          <button
            type="button"
            className="iconbtn nav-toggle"
            aria-label="Toggle navigation"
            aria-expanded={navOpen}
            onClick={() => setNavOpen((o) => !o)}
          >
            <MenuIcon />
          </button>
          <span className="muted nowrap">{breadcrumb(route)}</span>
          <span className="spacer" />
          <span className="faint nowrap" title="Command palette (⌘K)">⌘K</span>
          <ThemeToggle />
          <input
            style={{ width: 150 }}
            value={operator}
            placeholder="operator name"
            aria-label="Operator name"
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

function ThemeToggle() {
  const [choice, setChoice] = useState<ThemeChoice>(getTheme);
  const cycle = () => { const n = nextTheme(choice); setTheme(n); setChoice(n); };
  const label = choice === "system" ? "System theme" : choice === "dark" ? "Dark theme" : "Light theme";
  const Icon = choice === "system" ? MonitorIcon : choice === "dark" ? MoonIcon : SunIcon;
  return (
    <button type="button" className="iconbtn" onClick={cycle} title={`${label} — click to change`} aria-label={label}>
      <Icon />
    </button>
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
