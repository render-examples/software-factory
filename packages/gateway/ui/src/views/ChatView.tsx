import { useEffect, useRef, useState } from "react";
import { client } from "../api/client";
import { navigate, type Route } from "../state/router";
import { useApp } from "../state/app";
import { useAsync } from "../hooks/useAsync";
import { useThread, type ChatStatus } from "../hooks/useThread";
import { relativeTime } from "../lib/format";
import { ApprovalCard } from "../components/ApprovalCard";
import { ErrorBanner, CopyButton, Empty, Spinner, StatusBadge } from "../components/ui";
import { Markdown } from "../components/Markdown";
import type { ThreadMessage } from "../api/types";

// Former standalone Threads view lives here as a thread-picker pane
// (left), with the selected thread on the right.
export function ChatView({ route }: { route: Route }) {
  const threadId = route.segments[1];
  return (
    <div className={`chat-layout${threadId ? " has-active" : ""}`}>
      <ThreadList activeId={threadId} />
      <div className="convo-main">
        {threadId
          ? <ThreadPane key={threadId} threadId={threadId} />
          : <Empty>Pick a thread on the left, or start a new one.</Empty>}
      </div>
    </div>
  );
}

function ThreadList({ activeId }: { activeId?: string }) {
  const { lastEvent } = useApp();
  const [userId, setUserId] = useState("");
  const [creating, setCreating] = useState(false);
  const { data, loading, error, reload } = useAsync(() => client.listThreads(userId || undefined), [userId]);

  useEffect(() => {
    if (lastEvent?.category === "lifecycle") {
      const t = setTimeout(reload, 400);
      return () => clearTimeout(t);
    }
  }, [lastEvent, reload]);

  async function newThread() {
    setCreating(true);
    try {
      const t = await client.createThread({ title: "New thread", userId: userId || undefined });
      navigate(`chat/${t.id}`);
      reload();
    } finally {
      setCreating(false);
    }
  }

  return (
    <aside className="convo-list" aria-label="Threads">
      <div className="convo-list-head">
        <button className="primary" disabled={creating} onClick={newThread}>{creating ? <Spinner /> : "+ New"}</button>
        <input placeholder="filter by user id" value={userId} onChange={(e) => setUserId(e.target.value)} />
        <button className="ghost" aria-label="Reload" onClick={reload}>{loading ? <Spinner /> : "↻"}</button>
      </div>
      <ErrorBanner error={error} />
      <div className="convo-scroll">
        {(data?.threads.length ?? 0) === 0 && !loading ? (
          <Empty>No threads yet.</Empty>
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

function ThreadPane({ threadId }: { threadId: string }) {
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const {
    thread,
    messages,
    approvals,
    status,
    err,
    sending,
    liveTool,
    streamingText,
    runId,
    busy,
    inputBlocked,
    refresh,
    send,
    stop,
  } = useThread(threadId);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages.length, approvals.length, status]);

  async function sendMessage() {
    const content = draft.trim();
    if (!content || sending) return;
    setDraft("");
    await send(content);
  }

  return (
    <div className="chat">
      <div className="topbar" style={{ borderTop: "none" }}>
        <button className="ghost convo-back" onClick={() => navigate("chat")} aria-label="Back to threads">
          back to threads
        </button>
        <b>{thread?.title || "Thread"}</b>
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
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
          }}
        />
        {busy ? (
          <button className="danger" onClick={stop} title="Stop the current turn">Stop</button>
        ) : (
          <button className="primary" disabled={!draft.trim() || inputBlocked} onClick={sendMessage}>Send</button>
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
