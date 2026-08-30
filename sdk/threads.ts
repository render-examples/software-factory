/**
 * Thread store backed by Render Key Value (Redis-compatible).
 */
import { kv } from "./redis.js";

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
  thread.messages.push({ role, content, ts: new Date().toISOString() });
  const client = await kv();
  await client.set(`thread:${id}`, JSON.stringify(thread));
}
