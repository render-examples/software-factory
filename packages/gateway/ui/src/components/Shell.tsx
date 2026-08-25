import { useEffect, useState, type ReactNode } from "react";
import { useApp } from "../state/app";
import { navigate, type Route } from "../state/router";
import { GROUP_ORDER, NAV_ITEMS, type NavItem } from "../state/sections";
import { logout } from "../api/auth";
import { getTheme, nextTheme, setTheme, type ThemeChoice } from "../state/theme";
import { MenuIcon, SunIcon, MoonIcon, MonitorIcon } from "./Icons";

export function Shell({ route, children }: { route: Route; children: ReactNode }) {
  const { activeRuns, pendingApprovals, operator, setOperator, capabilities } = useApp();
  const top = route.segments[0] ?? "chat";
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => { setNavOpen(false); }, [route.hash]);

  const go = (id: string) => { navigate(id); setNavOpen(false); };

  const visible = NAV_ITEMS.filter((n) => !n.gate || (n.gate === "oauth" && capabilities.oauth));

  return (
    <div className={`app${navOpen ? " nav-open" : ""}`}>
      <div className="scrim" onClick={() => setNavOpen(false)} aria-hidden />
      <button
        type="button"
        className="iconbtn nav-toggle"
        aria-label="Toggle navigation"
        aria-expanded={navOpen}
        onClick={() => setNavOpen((o) => !o)}
      >
        <MenuIcon />
      </button>
      <aside className="rail" aria-label="Primary">
        <div className="brand"><b>render-factory</b><div className="muted">operator</div></div>
        <nav aria-label="Sections">
          {GROUP_ORDER.map((group) => {
            const items = visible.filter((n) => n.group === group.id);
            if (items.length === 0) return null;
            return (
              <div className="nav-group" key={group.id}>
                {items.map((item) => (
                  <NavLink
                    key={item.id}
                    item={item}
                    active={top === item.id}
                    badge={item.badge === "approvals" ? pendingApprovals : 0}
                    onGo={go}
                  />
                ))}
              </div>
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
          <div className="footer-controls">
            <input
              value={operator}
              placeholder="operator name"
              aria-label="Operator name"
              title="Local display name preference"
              onChange={(e) => setOperator(e.target.value)}
            />
            <div className="footer-row">
              <ThemeToggle />
              <button
                type="button"
                className="chip"
                title="End this session"
                onClick={async () => { await logout(); location.reload(); }}
              >
                sign out
              </button>
            </div>
          </div>
        </div>
      </aside>

      <div className="main">
        <div className="content">{children}</div>
      </div>
    </div>
  );
}

function NavLink({
  item, active, badge, onGo,
}: { item: NavItem; active: boolean; badge: number; onGo: (id: string) => void }) {
  const { Icon, id, label } = item;
  return (
    <a
      href={`#/${id}`}
      className={active ? "active" : ""}
      aria-current={active ? "page" : undefined}
      onClick={(e) => { e.preventDefault(); onGo(id); }}
    >
      <span className="ico"><Icon /></span>
      <span>{label}</span>
      {badge > 0 && <span className="badge" aria-label={`${badge} pending`}>{badge}</span>}
    </a>
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
