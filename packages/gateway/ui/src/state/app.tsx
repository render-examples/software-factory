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
}

const Ctx = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [activeRuns, setActiveRuns] = useState(0);
  const [pendingApprovals, setPendingApprovals] = useState(0);
  const [lastEvent, setLastEvent] = useState<GlobalEvent | null>(null);
  const [operator, setOperatorState] = useState(getOperator());
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const refreshCounts = useCallback(() => {
    Promise.all([
      client.listRuns({ status: "running", limit: 200 }).catch(() => ({ runs: [] })),
      client.listRuns({ status: "paused", limit: 200 }).catch(() => ({ runs: [] })),
      client.listApprovals("pending").catch(() => ({ approvals: [] })),
    ]).then(([running, paused, approvals]) => {
      setActiveRuns(running.runs.length + paused.runs.length);
      setPendingApprovals(approvals.approvals.length);
    });
  }, []);

  const scheduleRefresh = useCallback(() => {
    clearTimeout(debounce.current);
    debounce.current = setTimeout(refreshCounts, 250);
  }, [refreshCounts]);

  useEffect(() => {
    refreshCounts();
    const close = openSSE("/events/stream", (msg) => {
      const ev = msg.data as unknown as GlobalEvent;
      setLastEvent(ev);
      if (msg.category === "lifecycle" || msg.category === "approval") scheduleRefresh();
    });
    return close;
  }, [refreshCounts, scheduleRefresh]);

  const setOperator = useCallback((name: string) => {
    persistOperator(name);
    setOperatorState(name);
  }, []);

  return (
    <Ctx.Provider value={{ activeRuns, pendingApprovals, lastEvent, operator, setOperator, refreshCounts }}>
      {children}
    </Ctx.Provider>
  );
}

export function useApp(): AppState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useApp must be used within AppProvider");
  return ctx;
}
