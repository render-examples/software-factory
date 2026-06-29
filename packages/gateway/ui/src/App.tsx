import { AppProvider } from "./state/app";
import { useRoute } from "./state/router";
import { AuthGate } from "./components/AuthGate";
import { Shell } from "./components/Shell";
import { CommandPalette } from "./components/CommandPalette";
import { RunsView } from "./views/RunsView";
import { RunDetailView } from "./views/RunDetailView";
import { ApprovalsView } from "./views/ApprovalsView";
import { ChatView } from "./views/ChatView";
import { ThreadsView } from "./views/ThreadsView";
import { SchedulesView } from "./views/SchedulesView";

export function App() {
  return (
    <AuthGate>
      <AppProvider>
        <Routed />
        <CommandPalette />
      </AppProvider>
    </AuthGate>
  );
}

function Routed() {
  const route = useRoute();
  const [top] = route.segments;

  let view;
  switch (top) {
    case "runs":
      view = route.segments[1] ? <RunDetailView route={route} /> : <RunsView route={route} />;
      break;
    case "approvals": view = <ApprovalsView />; break;
    case "chat": view = <ChatView route={route} />; break;
    case "threads": view = <ThreadsView />; break;
    case "schedules": view = <SchedulesView />; break;
    default: view = <RunsView route={route} />;
  }

  return <Shell route={route}>{view}</Shell>;
}
