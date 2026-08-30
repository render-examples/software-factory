/**
 * Thread store backed by Render Key Value (Redis-compatible).
 */
import { kv } from "./redis.js";
import { maybePutBlob } from "./blobs.js";

/**
 * Thread messages are replayed as agent history long after they are written,
 * so they get a much longer TTL than the default (1h) used for transient
 * agent-output blobs.
 */
const THREAD_BLOB_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

export interface ThreadMessage {
  role: "user" | "assistant";
  content: string;
  ts: string;
}

export interface Thread {
  id: string;
  messages: ThreadMessage[];
  metadata: Record<string, string>;
}

export async function getThread(id: string): Promise<Thread | null> {
  const client = await kv();
  const raw = await client.get(`thread:${id}`);
  return raw ? (JSON.parse(raw) as Thread) : null;
}

export async function getOrCreateThread(
  id: string,
  metadata?: Record<string, string>,
): Promise<Thread> {
  const existing = await getThread(id);
  if (existing) return existing;
  const thread: Thread = { id, messages: [], metadata: metadata ?? {} };
  const client = await kv();
  await client.set(`thread:${id}`, JSON.stringify(thread));
  return thread;
}

export async function appendMessage(
  id: string,
  role: "user" | "assistant",
  content: string,
): Promise<void> {
  const thread = await getOrCreateThread(id);

  // Large messages are offloaded to blob storage so the thread record stays
  // small. `$blob:` refs are resolved on read (see agentTask history replay).
  // Refs must not contain whitespace, so the thread id is sanitised.
  const runId = `thread:${id.replace(/\s+/g, "_")}`;
  const step = `${role}-${thread.messages.length}`;
  const stored = await maybePutBlob(runId, step, content, THREAD_BLOB_TTL_SECONDS);

  thread.messages.push({ role, content: stored, ts: new Date().toISOString() });
  const client = await kv();
  await client.set(`thread:${id}`, JSON.stringify(thread));
}
