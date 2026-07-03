import { useCallback, useEffect, useRef, useState } from "react";
import { client, ApiError } from "../api/client";
import { openSSE } from "../api/sse";
import { navigate, type Route } from "../state/router";
import { useApp } from "../state/app";
import { useAsync } from "../hooks/useAsync";
import { relativeTime } from "../lib/format";
import { ApprovalCard } from "../components/ApprovalCard";
import { ErrorBanner, CopyButton, Empty, Spinner, StatusBadge } from "../components/ui";
import { Markdown } from "../components/Markdown";
import { useToast } from "../components/Toaster";
import type { Approval, RunStatus, Thread, ThreadMessage } from "../api/types";

type ChatStatus = "idle" | "thinking" | "waiting" | "needs-approval" | "failed";

// Chat is the app's primary object. The former standalone Threads view now lives
// here as a conversation-picker pane (left), with the selected conversation on
// the right — one surface instead of two overlapping doors to the same data.
export function ChatView({ route }: { route: Route }) {
  const threadId = route.segments[1];
  return (
    <div className={`chat-layout${threadId ? " has-active" : ""}`}>
      <ConversationList activeId={threadId} />
      <div className="convo-main">
        {threadId
          ? <Conversation key={threadId} threadId={threadId} />
          : <Empty>Pick a conversation on the left, or start a new one.</Empty>}
      </div>
    </div>
  );
}

function ConversationList({ activeId }: { activeId?: string }) {
  const { lastEvent } = useApp();
  const [userId, setUserId] = useState("");
  const [creating, setCreating] = useState(false);
  const { data, loading, error, reload } = useAsync(() => client.listThreads(userId || undefined), [userId]);

  // Reflect new turns / new threads as they happen.
  useEffect(() => {
    if (lastEvent?.category === "lifecycle") {
      const t = setTimeout(reload, 400);
      return () => clearTimeout(t);
    }
  }, [lastEvent, reload]);

  async function newThread() {
    setCreating(true);
    try {
      const t = await client.createThread({ title: "New conversation", userId: userId || undefined });
      navigate(`chat/${t.id}`);
      reload();
    } finally {
      setCreating(false);
    }
  }

  return (
    <aside className="convo-list" aria-label="Conversations">
      <div className="convo-list-head">
        <button className="primary" disabled={creating} onClick={newThread}>{creating ? <Spinner /> : "+ New"}</button>
        <input placeholder="filter by user id" value={userId} onChange={(e) => setUserId(e.target.value)} />
        <button className="ghost" aria-label="Reload" onClick={reload}>{loading ? <Spinner /> : "↻"}</button>
      </div>
      <ErrorBanner error={error} />
      <div className="convo-scroll">
        {(data?.threads.length ?? 0) === 0 && !loading ? (
          <Empty>No conversations yet.</Empty>
        ) : (
          data?.threads.map((t) => (
            <button
              key={t.id}
              className={`convo-item${t.id === activeId ? " active" : ""}`}
              onClick={() => navigate(`chat/${t.id}`)}
            >
              <span className="convo-title">{t.title || <span className="faint mono">{t.id.slice(0, 12)}…</span>}</span>
              <span className="convo-meta">
                <StatusBadge status={t.status} />
                <span className="muted">{relativeTime(t.updatedAt)}</span>
              </span>
            </button>
          ))
        )}
      </div>
    </aside>
  );
}

function Conversation({ threadId }: { threadId: string }) {
  const [thread, setThread] = useState<Thread | null>(null);
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [status, setStatus] = useState<ChatStatus>("idle");
  const [draft, setDraft] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [liveTool, setLiveTool] = useState<string | null>(null);
  // Live token stream (D13): transient text.delta buffer for the in-flight turn.
  // Replaced by the canonical message.assistant once the transcript refetches.
  const [streamingText, setStreamingText] = useState("");
  const activeRunId = useRef<string | undefined>(undefined);
  // The last canonical assistant message id we've rendered for the active run.
  // Streaming preview is dropped only when a *newer* assistant message appears,
  // so a multi-iteration turn (tool calls) doesn't wipe the live buffer of a
  // later iteration just because an earlier assistant message already exists.
  const lastAssistantId = useRef<string | undefined>(undefined);
  const scrollRef = useRef<HTMLDivElement>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const toast = useToast();

  const refresh = useCallback(async () => {
    try {
      const { thread: t, messages: m } = await client.getThread(threadId);
      setThread(t);
      setMessages(m);
      // Derive the thread's active run client-side (rather than the data model
      // carrying a UI-shaped `currentRunId`): the thread's turns are root runs,
      // and at most one is non-terminal at a time (enforced by the store's
      // partial unique index). Only seed when we don't already have one — an
      // in-session turn sets `activeRunId` when it starts.
      if (!activeRunId.current) {
        const { runs } = await client.listRuns({ threadId, limit: 20 });
        const active = runs.find(
          (r) => r.status === "pending" || r.status === "running" || r.status === "paused",
        );
        if (active) activeRunId.current = active.id;
      }

      // Pending approvals for this thread, scoped server-side (one request).
      const mine = (await client.listInputs("pending", threadId, "approval")).approvals;
      setApprovals(mine);

      let runStatus: RunStatus | undefined;
      if (activeRunId.current) {
        try {
          const run = await client.getRun(activeRunId.current);
          runStatus = run.status;
        } catch { /* */ }
      }
      const next = deriveStatus(t, runStatus, mine.length > 0);
      setStatus(next);
      if (next !== "thinking") setLiveTool(null);
      // Drop the transient stream buffer only when a *new* canonical assistant
      // message for the active run appears (id changed since we last saw one),
      // so the durable message replaces the live preview without wiping the
      // buffer mid-stream on a later tool-loop iteration.
      const latestAssistant = [...m].reverse().find(
        (msg) => msg.role === "assistant" && msg.runId === activeRunId.current,
      );
      if (latestAssistant && latestAssistant.id !== lastAssistantId.current) {
        lastAssistantId.current = latestAssistant.id;
        setStreamingText("");
      }
      // Once the active turn reaches a terminal state, forget it so the next
      // refresh re-resolves the thread's active run — otherwise Stop and SSE
      // scoping keep targeting a completed run (CR-20).
      if (runStatus === "completed" || runStatus === "failed" || runStatus === "cancelled") {
        activeRunId.current = undefined;
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
    // transcript refetch (message-level streaming — the finished assistant turn
    // appears on the next refetch).
    const close = openSSE(`/threads/${threadId}/stream`, (msg) => {
      const p = msg.data;
      // Token-level streaming: append deltas live and skip the transcript
      // refetch (the finished turn arrives on the next durable event's refresh).
      if (msg.category === "message" && p.type === "text.delta" && typeof p.text === "string") {
        // Scope deltas to the active run: the thread stream carries deltas for
        // every run in the thread, so ignore any that aren't this turn's (avoids
        // a stray/older run flipping status or polluting the buffer).
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

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages.length, approvals.length, status]);

  async function send() {
    const content = draft.trim();
    if (!content || sending) return;
    setSending(true);
    setErr(null);
    setMessages((m) => [...m, { id: `local-${Date.now()}`, threadId, runId: "", seq: -1, role: "user", content, createdAt: new Date().toISOString() }]);
    setDraft("");
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
  }

  async function stop() {
    const runId = activeRunId.current;
    if (!runId) return;
    try {
      await client.cancelRun(runId);
      toast.info("Stopping the current turn…");
      setTimeout(refresh, 150);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e), "Couldn't stop");
    }
  }

  const busy = status === "thinking";
  // The composer is blocked while the turn is mid-flight (`thinking`) and while
  // an approval is pending (`needs-approval`) — the server 409s a message during
  // an approval pause (BUG-11), so prevent it in the UI. An input pause
  // (`waiting`) intentionally keeps the composer open: the reply resumes the run.
  const inputBlocked = status === "thinking" || status === "needs-approval";
  const runId = activeRunId.current;

  return (
    <div className="chat">
      <div className="topbar" style={{ borderTop: "none" }}>
        <b>{thread?.title || "Conversation"}</b>
        <span className="chip mono">{threadId.slice(0, 8)}</span>
        <StatusLine status={status} />
        <span className="spacer" />
        {runId && <a href={`#/runs/${runId}`} onClick={(e) => { e.preventDefault(); navigate(`runs/${runId}`); }}>open trace ↗</a>}
      </div>

      <div className="scroll" ref={scrollRef}>
        <ErrorBanner error={err} />
        {messages.map((m) => <Bubble key={m.id} msg={m} />)}
        {approvals.map((a) => (
          <div key={a.id} style={{ maxWidth: 760 }}>
            <ApprovalCard approval={a} showRunLink onResolved={() => setTimeout(refresh, 150)} />
          </div>
        ))}
        {busy && (
          <div className="msg assistant">
            <div className="who">assistant</div>
            <div className="bubble">
              {streamingText
                ? <Markdown>{streamingText}</Markdown>
                : <ThinkingIndicator tool={liveTool} />}
            </div>
          </div>
        )}
      </div>

      <div className="composer">
        <textarea
          placeholder={
            status === "needs-approval"
              ? "Resolve the approval above to continue…"
              : status === "waiting"
                ? "The agent is waiting for your reply…"
                : "Message the agent…  (Enter to send, Shift+Enter for newline)"
          }
          value={draft}
          disabled={inputBlocked}
          aria-label="Message"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
          }}
        />
        {busy ? (
          <button className="danger" onClick={stop} title="Stop the current turn">Stop</button>
        ) : (
          <button className="primary" disabled={!draft.trim() || inputBlocked} onClick={send}>Send</button>
        )}
      </div>
    </div>
  );
}

function Bubble({ msg }: { msg: ThreadMessage }) {
  const isAssistant = msg.role === "assistant";
  return (
    <div className={`msg ${msg.role}`}>
      <div className="who">
        <span>{msg.role}</span>
        {msg.runId && msg.seq >= 0 && (
          <a href={`#/runs/${msg.runId}`} onClick={(e) => { e.preventDefault(); navigate(`runs/${msg.runId}`); }}>trace</a>
        )}
        {isAssistant && msg.content && <span className="copy"><CopyButton text={msg.content} /></span>}
      </div>
      <div className="bubble">
        {isAssistant ? <Markdown>{msg.content}</Markdown> : msg.content}
      </div>
    </div>
  );
}

const PHRASES = ["Thinking…", "Working on it…", "Reasoning…", "Composing a reply…"];

function ThinkingIndicator({ tool }: { tool: string | null }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) return;
    const t = setInterval(() => setI((n) => (n + 1) % PHRASES.length), 2400);
    return () => clearInterval(t);
  }, []);
  return (
    <span className="thinking">
      <span className="dots"><i /><i /><i /></span>
      {tool ? <span className="tool-live">using {tool}…</span> : <span>{PHRASES[i]}</span>}
    </span>
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

function deriveStatus(
  thread: Thread,
  runStatus: RunStatus | undefined,
  hasApproval: boolean,
): ChatStatus {
  if (hasApproval) return "needs-approval";
  if (runStatus === "running" || runStatus === "pending") return "thinking";
  if (runStatus === "paused") {
    // Distinguish the pause reason from the authoritative `run.paused` event
    // rather than inferring solely from the approval list (BUG-12): an approval
    // pause is `needs-approval` even in the brief window before the approval row
    // is fetched; only an input pause is `waiting` (the user should reply).
    return hasApproval ? "needs-approval" : "waiting";
  }
  if (runStatus === "failed" || thread.status === "failed") return "failed";
  return "idle";
}
