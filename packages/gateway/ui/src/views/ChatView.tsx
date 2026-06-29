import { useCallback, useEffect, useRef, useState } from "react";
import { client, ApiError } from "../api/client";
import { openSSE } from "../api/sse";
import { navigate, type Route } from "../state/router";
import { ApprovalCard } from "../components/ApprovalCard";
import { ErrorBanner, Spinner } from "../components/ui";
import { ThreadsView } from "./ThreadsView";
import type { Approval, RunStatus, Thread, ThreadMessage } from "../api/types";

type ChatStatus = "idle" | "thinking" | "waiting" | "needs-approval" | "failed";

export function ChatView({ route }: { route: Route }) {
  const threadId = route.segments[1];
  if (!threadId) return <ThreadsView />;
  return <Conversation key={threadId} threadId={threadId} />;
}

function Conversation({ threadId }: { threadId: string }) {
  const [thread, setThread] = useState<Thread | null>(null);
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [status, setStatus] = useState<ChatStatus>("idle");
  const [draft, setDraft] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const activeRunId = useRef<string | undefined>(undefined);
  const scrollRef = useRef<HTMLDivElement>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const refresh = useCallback(async () => {
    try {
      const { thread: t, messages: m } = await client.getThread(threadId);
      setThread(t);
      setMessages(m);
      if (!activeRunId.current && t.currentRunId) activeRunId.current = t.currentRunId;

      // Find pending approvals belonging to this thread (cross-reference runId→threadId).
      const pend = (await client.listApprovals("pending")).approvals;
      const mine: Approval[] = [];
      let runStatus: RunStatus | undefined;
      for (const a of pend) {
        try {
          const run = await client.getRun(a.runId);
          if (run.threadId === threadId) mine.push(a);
        } catch { /* run may be gone */ }
      }
      setApprovals(mine);

      if (activeRunId.current) {
        try { runStatus = (await client.getRun(activeRunId.current)).status; } catch { /* */ }
      }
      setStatus(deriveStatus(t, runStatus, mine.length > 0));
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
    const close = openSSE(`/threads/${threadId}/stream`, scheduleRefresh);
    return () => { clearTimeout(debounce.current); close(); };
  }, [threadId, refresh, scheduleRefresh]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages.length, approvals.length]);

  async function send() {
    const content = draft.trim();
    if (!content || sending) return;
    setSending(true);
    setErr(null);
    // optimistic echo
    setMessages((m) => [...m, { id: `local-${Date.now()}`, threadId, runId: "", seq: -1, role: "user", content, createdAt: new Date().toISOString() }]);
    setDraft("");
    setStatus("thinking");
    try {
      const res = await client.sendMessage(threadId, content) as { runId?: string };
      if (res?.runId) activeRunId.current = res.runId;
      setTimeout(refresh, 200);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setStatus("idle");
    } finally {
      setSending(false);
    }
  }

  const busy = status === "thinking";

  return (
    <div className="chat">
      <div className="topbar" style={{ borderTop: "none" }}>
        <b>{thread?.title || "Conversation"}</b>
        <span className="chip mono">{threadId.slice(0, 8)}</span>
        <StatusLine status={status} />
        <span className="spacer" />
        {activeRunId.current && <a href={`#/runs/${activeRunId.current}`} onClick={(e) => { e.preventDefault(); navigate(`runs/${activeRunId.current}`); }}>open trace ↗</a>}
      </div>

      <div className="scroll" ref={scrollRef}>
        <ErrorBanner error={err} />
        {messages.map((m) => <Bubble key={m.id} msg={m} />)}
        {approvals.map((a) => (
          <div key={a.id} style={{ maxWidth: 760 }}>
            <ApprovalCard approval={a} showRunLink onResolved={() => setTimeout(refresh, 150)} />
          </div>
        ))}
        {busy && <div className="msg assistant"><div className="who">assistant</div><div className="bubble"><Spinner /> thinking…</div></div>}
      </div>

      <div className="composer">
        <textarea
          placeholder={status === "needs-approval" ? "Resolve the approval above to continue…" : "Message the agent…  (Enter to send, Shift+Enter for newline)"}
          value={draft}
          disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
        />
        <button className="primary" disabled={busy || !draft.trim()} onClick={send}>Send</button>
      </div>
    </div>
  );
}

function Bubble({ msg }: { msg: ThreadMessage }) {
  return (
    <div className={`msg ${msg.role}`}>
      <div className="who">{msg.role}{msg.runId && msg.seq >= 0 ? <a style={{ marginLeft: 6 }} href={`#/runs/${msg.runId}`} onClick={(e) => { e.preventDefault(); navigate(`runs/${msg.runId}`); }}>trace</a> : null}</div>
      <div className="bubble">{msg.content}</div>
    </div>
  );
}

function StatusLine({ status }: { status: ChatStatus }) {
  const map: Record<ChatStatus, { label: string; cls: string }> = {
    idle: { label: "idle", cls: "muted" },
    thinking: { label: "● thinking", cls: "s-running" },
    waiting: { label: "waiting for you", cls: "s-paused" },
    "needs-approval": { label: "needs approval", cls: "s-paused" },
    failed: { label: "failed", cls: "s-failed" },
  };
  const s = map[status];
  return <span className={`live-tag ${s.cls}`} style={{ border: "none" }}>{s.label}</span>;
}

function deriveStatus(thread: Thread, runStatus: RunStatus | undefined, hasApproval: boolean): ChatStatus {
  if (hasApproval) return "needs-approval";
  if (runStatus === "running" || runStatus === "pending") return "thinking";
  if (runStatus === "paused") return "waiting";
  if (runStatus === "failed" || thread.status === "failed") return "failed";
  return "idle";
}
