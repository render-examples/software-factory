import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { client } from "../api/client";
import { openSSE } from "../api/sse";
import { getOperator, setOperator as persistOperator } from "../api/auth";
import type { GlobalEvent } from "../api/types";

interface AppState {
  activeRuns: number;
  pendingApprovals: number;
  /** Latest event from the global tail; views may react to it. */
  lastEvent: GlobalEvent | null;
  operator: string;
  setOperator: (name: string) => void;
  refreshCounts: () => void;
  /** Runtime capabilities probed on boot (gates optional nav items). */
  capabilities: { oauth: boolean };
}

const Ctx = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [activeRuns, setActiveRuns] = useState(0);
  const [pendingApprovals, setPendingApprovals] = useState(0);
  const [lastEvent, setLastEvent] = useState<GlobalEvent | null>(null);
  const [operator, setOperatorState] = useState(getOperator());
  const [oauth, setOauth] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const refreshCounts = useCallback(() => {
    Promise.all([
      client.runCounts().catch(() => ({ active: 0 })),
      client.inputCounts({ status: "pending", kind: "approval" }).catch(() => ({ pendingApprovals: 0 })),
    ]).then(([runs, inputs]) => {
      setActiveRuns(runs.active);
      setPendingApprovals(inputs.pendingApprovals);
    });
  }, []);

  const scheduleRefresh = useCallback(() => {
    clearTimeout(debounce.current);
    debounce.current = setTimeout(refreshCounts, 250);
  }, [refreshCounts]);

  useEffect(() => {
    refreshCounts();
    // Probe OAuth support once: /connections is only registered when providers
    // are configured, so a non-empty list gates the Connections nav item in.
    client.listConnections()
      .then((r) => setOauth((r.providers?.length ?? 0) > 0))
      .catch(() => setOauth(false));
    const close = openSSE("/events/stream", (msg) => {
      const ev = msg.data as unknown as GlobalEvent;
      setLastEvent(ev);
      if (msg.category === "lifecycle" || msg.category === "input") scheduleRefresh();
    });
    return close;
  }, [refreshCounts, scheduleRefresh]);

  const setOperator = useCallback((name: string) => {
    persistOperator(name);
    setOperatorState(name);
  }, []);

  return (
    <Ctx.Provider value={{ activeRuns, pendingApprovals, lastEvent, operator, setOperator, refreshCounts, capabilities: { oauth } }}>
      {children}
    </Ctx.Provider>
  );
}

export function useApp(): AppState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useApp must be used within AppProvider");
  return ctx;
}
