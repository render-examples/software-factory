export function formatCost(usd: number | undefined): string {
  const n = Number(usd ?? 0);
  if (n === 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

export function formatDuration(startedAt?: string, finishedAt?: string): string {
  if (!startedAt) return "—";
  const start = Date.parse(startedAt);
  const end = finishedAt ? Date.parse(finishedAt) : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end)) return "—";
  const ms = Math.max(0, end - start);
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  if (m < 60) return `${m}m ${s}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function relativeTime(iso?: string): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const diff = Date.now() - t;
  const s = Math.round(diff / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function truncate(s: string, n = 80): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

export function pretty(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** Short, human-readable one-liner for a run event payload (log inspector). */
export function summarizeEvent(type: string, payload: Record<string, unknown>): string {
  switch (type) {
    case "run.started": return `trigger=${payload.trigger ?? "?"}${payload.model ? ` model=${payload.model}` : ""}`;
    case "run.completed": return "ok";
    case "run.failed": return String(payload.error ?? "");
    case "run.paused": return `reason=${payload.reason ?? "?"}`;
    case "message.user": return contentText(payload.content);
    case "message.assistant": return `${payload.agentName ?? ""}: ${contentText(payload.content)}`;
    case "message.tool": return `${payload.agentName ?? ""}: tool result`;
    case "text.delta": return String(payload.text ?? "");
    case "tool.called": return `${payload.name} ${truncate(pretty(payload.input), 60)}`;
    case "tool.result": return `${payload.name} → ${truncate(pretty((payload.result as { content?: unknown })?.content), 60)}`;
    case "step.started": return String(payload.name ?? "");
    case "step.completed": return `${payload.name} done`;
    case "llm.call": {
      const u = payload.usage as { inputTokens?: number; outputTokens?: number } | undefined;
      return `${payload.model} · ${u?.inputTokens ?? 0}/${u?.outputTokens ?? 0} tok · ${payload.stopReason}`;
    }
    case "input.requested": return `${payload.toolName} (${payload.inputRequestId})`;
    case "input.provided": return `${payload.approved ? "approved" : "denied"}${payload.providedBy ? ` by ${payload.providedBy}` : ""}${payload.reason ? ` — ${payload.reason}` : ""}`;
    case "input.auto": return `auto-approved ${payload.toolName}`;
    case "subagent.spawned": return `${payload.agentName} → ${String(payload.childRunId ?? "").slice(0, 8)}`;
    case "context.compacted": return `${payload.strategy}: ${payload.beforeTokens}→${payload.afterTokens} tok`;
    default: return truncate(pretty(payload), 70);
  }
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return truncate(
    content
      .map((b) => (b && typeof b === "object" && (b as { type?: string }).type === "text" ? (b as { text?: string }).text ?? "" : ""))
      .join(" ")
      .trim(),
    70,
  );
}

/** Extract concatenated text from a ContentBlock[] (for chat / messages). */
export function blocksToText(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === "string" ? content : "";
  return content
    .map((b) => {
      if (!b || typeof b !== "object") return "";
      const block = b as { type?: string; text?: string };
      if (block.type === "text") return block.text ?? "";
      return "";
    })
    .join("")
    .trim();
}
