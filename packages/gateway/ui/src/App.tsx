import { Suspense, lazy, type ReactNode } from "react";
import { AppProvider } from "./state/app";
import { useRoute, navigate, type Route } from "./state/router";
import { DEFAULT_SECTION } from "./state/sections";
import { AuthGate } from "./components/AuthGate";
import { Shell } from "./components/Shell";
import { CommandPalette } from "./components/CommandPalette";
import { ToastProvider } from "./components/Toaster";
import { Empty, Spinner } from "./components/ui";

const ChatView = lazy(() => import("./views/ChatView").then((m) => ({ default: m.ChatView })));
const WorkflowsView = lazy(() => import("./views/WorkflowsView").then((m) => ({ default: m.WorkflowsView })));
const SchedulesView = lazy(() => import("./views/SchedulesView").then((m) => ({ default: m.SchedulesView })));
const RunsView = lazy(() => import("./views/RunsView").then((m) => ({ default: m.RunsView })));
const RunDetailView = lazy(() => import("./views/RunDetailView").then((m) => ({ default: m.RunDetailView })));
const ApprovalsView = lazy(() => import("./views/ApprovalsView").then((m) => ({ default: m.ApprovalsView })));
const ConnectionsView = lazy(() => import("./views/ConnectionsView").then((m) => ({ default: m.ConnectionsView })));
const OpsView = lazy(() => import("./views/OpsView").then((m) => ({ default: m.OpsView })));

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
  return (
    <Shell route={route}>
      <Suspense fallback={<div className="panel"><Spinner /> loading view…</div>}>
        {renderSection(section, route)}
      </Suspense>
    </Shell>
  );
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
