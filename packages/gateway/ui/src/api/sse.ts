import { getKey } from "./auth";
import type { EventCategory } from "./types";

const CATEGORIES: EventCategory[] = [
  "lifecycle", "message", "tool", "step", "model", "approval", "delegation", "context",
];

export interface StreamMessage {
  category: EventCategory;
  /** Parsed `data`. For per-run/thread streams this is the RunEvent payload; for
   *  the global stream it is the full record (with `runId`, `seq`, `payload`). */
  data: Record<string, unknown> & { type?: string };
}

/**
 * Open an SSE stream against a gateway stream endpoint. The API key rides as a
 * `?key=` query param (EventSource can't set headers). EventSource auto-reconnects
 * and replays `Last-Event-ID`, so the server resumes from the last event id — a
 * numeric `seq` for a single-run stream, or a composite `runId:seq` for the
 * thread/global streams (per-run seq collides across a thread's runs).
 * Returns a close function.
 */
export function openSSE(
  path: string,
  onMessage: (msg: StreamMessage) => void,
  onError?: (e: Event) => void,
): () => void {
  const sep = path.includes("?") ? "&" : "?";
  const url = `${path}${sep}key=${encodeURIComponent(getKey())}`;
  const es = new EventSource(url);

  const handle = (category: EventCategory) => (e: MessageEvent) => {
    try {
      onMessage({ category, data: JSON.parse(e.data) });
    } catch {
      /* ignore malformed frame */
    }
  };
  for (const c of CATEGORIES) es.addEventListener(c, handle(c) as EventListener);
  if (onError) es.onerror = onError;

  return () => es.close();
}
