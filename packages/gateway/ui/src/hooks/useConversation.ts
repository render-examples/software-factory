import { useCallback, useEffect, useRef, useState } from "react";
import { client, ApiError } from "../api/client";
import { openSSE } from "../api/sse";
import { useToast } from "../components/Toaster";
import type { Approval, RunStatus, Thread, ThreadMessage } from "../api/types";

export type ChatStatus = "idle" | "thinking" | "waiting" | "needs-approval" | "failed";

export interface ConversationState {
  thread: Thread | null;
  messages: ThreadMessage[];
  approvals: Approval[];
  status: ChatStatus;
  err: string | null;
  sending: boolean;
  liveTool: string | null;
  streamingText: string;
  runId?: string;
  busy: boolean;
  inputBlocked: boolean;
  refresh: () => Promise<void>;
  send: (content: string) => Promise<void>;
  stop: () => Promise<void>;
}

export function useConversation(threadId: string): ConversationState {
  const [thread, setThread] = useState<Thread | null>(null);
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [status, setStatus] = useState<ChatStatus>("idle");
  const [err, setErr] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [liveTool, setLiveTool] = useState<string | null>(null);
  // Live token stream (D13): transient text.delta buffer for the in-flight turn.
  // Replaced by the canonical message.assistant once the transcript refetches.
  const [streamingText, setStreamingText] = useState("");
  const activeRunId = useRef<string | undefined>(undefined);
  // The last canonical assistant message id we've rendered for the active run.
  // Streaming preview is dropped only when a newer assistant message appears.
  const lastAssistantId = useRef<string | undefined>(undefined);
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const toast = useToast();

  const refresh = useCallback(async () => {
    try {
      const view = await client.getThreadView(threadId);
      const { thread: t, messages: m } = view;
      setThread(t);
      setMessages(m);
      // Consolidated thread view returns the active run + pending approvals so
      // refreshes don't fan out to listRuns/listInputs/getRun each cycle.
      activeRunId.current = view.activeRun?.id;
      const mine = view.approvals;
      setApprovals(mine);
      const runStatus: RunStatus | undefined = view.activeRun?.status;
      const next = deriveStatus(t, runStatus, mine.length > 0);
      setStatus(next);
      if (next !== "thinking") setLiveTool(null);
      // Drop the transient stream buffer only when a new canonical assistant
      // message for the active run appears.
      const latestAssistant = [...m].reverse().find(
        (msg) => msg.role === "assistant" && msg.runId === activeRunId.current,
      );
      if (latestAssistant && latestAssistant.id !== lastAssistantId.current) {
        lastAssistantId.current = latestAssistant.id;
        setStreamingText("");
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setErr("Thread not found.");
    }
  }, [threadId]);

  const scheduleRefresh = useCallback(() => {
    clearTimeout(debounce.current);
    debounce.current = setTimeout(refresh, 250);
  }, [refresh]);

  useEffect(() => {
    refresh();
    // Fold live events: reflect tool activity immediately, and debounce a full
    // transcript refetch.
    const close = openSSE(`/threads/${threadId}/stream`, (msg) => {
      const p = msg.data;
      // Token-level streaming: append deltas live and skip transcript refetch.
      if (msg.category === "message" && p.type === "text.delta" && typeof p.text === "string") {
        // Scope deltas to the active run.
        if (activeRunId.current && typeof p.runId === "string" && p.runId !== activeRunId.current) return;
        setStreamingText((t) => t + p.text);
        setStatus((s) => (s === "idle" ? "thinking" : s));
        return;
      }
      if (msg.category === "tool") {
        if (p.type === "tool.called" && typeof p.name === "string") setLiveTool(p.name);
        else if (p.type === "tool.result") setLiveTool(null);
      }
      scheduleRefresh();
    });
    return () => { clearTimeout(debounce.current); close(); };
  }, [threadId, refresh, scheduleRefresh]);

  const send = useCallback(async (rawContent: string) => {
    const content = rawContent.trim();
    if (!content || sending) return;
    setSending(true);
    setErr(null);
    setMessages((m) => [...m, { id: `local-${Date.now()}`, threadId, runId: "", seq: -1, role: "user", content, createdAt: new Date().toISOString() }]);
    setStreamingText("");
    lastAssistantId.current = undefined;
    setStatus("thinking");
    try {
      const res = await client.sendMessage(threadId, content) as { runId?: string };
      if (res?.runId) activeRunId.current = res.runId;
      setTimeout(refresh, 200);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setErr(message);
      toast.error(message, "Message failed");
      setStatus("idle");
    } finally {
      setSending(false);
    }
  }, [refresh, sending, threadId, toast]);

  const stop = useCallback(async () => {
    const runId = activeRunId.current;
    if (!runId) return;
    try {
      await client.cancelRun(runId);
      toast.info("Stopping the current turn...");
      setTimeout(refresh, 150);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e), "Couldn't stop");
    }
  }, [refresh, toast]);

  const busy = status === "thinking";
  // The composer is blocked while the turn is mid-flight and while an approval
  // is pending. Waiting-for-input pauses intentionally keep the composer open.
  const inputBlocked = status === "thinking" || status === "needs-approval";

  return {
    thread,
    messages,
    approvals,
    status,
    err,
    sending,
    liveTool,
    streamingText,
    runId: activeRunId.current,
    busy,
    inputBlocked,
    refresh,
    send,
    stop,
  };
}

function deriveStatus(
  thread: Thread,
  runStatus: RunStatus | undefined,
  hasApproval: boolean,
): ChatStatus {
  if (hasApproval) return "needs-approval";
  if (runStatus === "running" || runStatus === "pending") return "thinking";
  if (runStatus === "paused") {
    return hasApproval ? "needs-approval" : "waiting";
  }
  if (runStatus === "failed" || thread.status === "failed") return "failed";
  return "idle";
}
