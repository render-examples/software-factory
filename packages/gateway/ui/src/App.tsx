import type { ReactNode } from "react";
import { AppProvider } from "./state/app";
import { useRoute, navigate, type Route } from "./state/router";
import { DEFAULT_SECTION } from "./state/sections";
import { AuthGate } from "./components/AuthGate";
import { Shell } from "./components/Shell";
import { CommandPalette } from "./components/CommandPalette";
import { ToastProvider } from "./components/Toaster";
import { Empty } from "./components/ui";
import { RunsView } from "./views/RunsView";
import { RunDetailView } from "./views/RunDetailView";
import { ApprovalsView } from "./views/ApprovalsView";
import { ChatView } from "./views/ChatView";
import { SchedulesView } from "./views/SchedulesView";
import { WorkflowsView } from "./views/WorkflowsView";
import { ConnectionsView } from "./views/ConnectionsView";
import { OpsView } from "./views/OpsView";

export function App() {
  return (
    <ToastProvider>
      <AuthGate>
        <AppProvider>
          <Routed />
          <CommandPalette />
        </AppProvider>
      </AuthGate>
    </ToastProvider>
  );
}

function Routed() {
  const route = useRoute();
  const section = route.segments[0] ?? DEFAULT_SECTION;
  return <Shell route={route}>{renderSection(section, route)}</Shell>;
}

function renderSection(id: string, route: Route): ReactNode {
  switch (id) {
    case "chat": return <ChatView route={route} />;
    case "workflows": return <WorkflowsView route={route} />;
    case "schedules": return <SchedulesView />;
    case "runs": return route.segments[1] ? <RunDetailView route={route} /> : <RunsView route={route} />;
    case "approvals": return <ApprovalsView />;
    case "connections": return <ConnectionsView />;
    case "ops": return <OpsView />;
    default: return <NotFound id={id} />;
  }
}

function NotFound({ id }: { id: string }) {
  return (
    <div className="panel">
      <Empty>
        <div style={{ display: "grid", gap: "0.6rem", justifyItems: "center" }}>
          <div>No view for <span className="mono">#/{id}</span>.</div>
          <button className="primary" onClick={() => navigate(DEFAULT_SECTION)}>Go to Chat</button>
        </div>
      </Empty>
    </div>
  );
}
