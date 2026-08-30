import { describe, it, expect, vi, beforeEach } from "vitest";

const store = new Map<string, { value: string; ex?: number }>();

vi.mock("../redis.js", () => ({
  kv: async () => ({
    get: async (key: string) => store.get(key)?.value ?? null,
    set: async (key: string, value: string, opts?: { EX?: number }) => {
      store.set(key, { value, ex: opts?.EX });
    },
    del: async (key: string) => {
      store.delete(key);
    },
  }),
}));

import { appendMessage, getOrCreateThread, getThread } from "../threads.js";
import { getBlob, resolveRefs, BLOB_THRESHOLD } from "../blobs.js";

beforeEach(() => {
  store.clear();
});

describe("appendMessage", () => {
  it("stores small messages inline", async () => {
    await appendMessage("t1", "user", "hello");

    const thread = await getThread("t1");
    expect(thread?.messages).toHaveLength(1);
    expect(thread?.messages[0]).toMatchObject({ role: "user", content: "hello" });
    expect(store.size).toBe(1);
  });

  it("blob-caps a message above the threshold", async () => {
    const large = "x".repeat(BLOB_THRESHOLD + 1);
    await appendMessage("t1", "user", large);

    const thread = await getThread("t1");
    const stored = thread!.messages[0].content;
    expect(stored).toMatch(/^\$blob:/);
    expect(stored.length).toBeLessThan(200);

    expect(await getBlob(stored)).toBe(large);
    expect(await resolveRefs(stored)).toBe(large);
  });

  it("keeps the thread record small when capping", async () => {
    const large = "x".repeat(BLOB_THRESHOLD + 1);
    await appendMessage("t1", "user", large);

    const raw = store.get("thread:t1")!.value;
    expect(raw.length).toBeLessThan(BLOB_THRESHOLD);
  });

  it("does not collide across messages in the same thread", async () => {
    const a = "a".repeat(BLOB_THRESHOLD + 1);
    const b = "b".repeat(BLOB_THRESHOLD + 1);
    await appendMessage("t1", "user", a);
    await appendMessage("t1", "assistant", b);

    const thread = await getThread("t1");
    const [first, second] = thread!.messages.map((m) => m.content);
    expect(first).not.toBe(second);
    expect(await getBlob(first)).toBe(a);
    expect(await getBlob(second)).toBe(b);
  });

  it("does not collide when identical content is appended twice", async () => {
    const same = "z".repeat(BLOB_THRESHOLD + 1);
    await appendMessage("t1", "user", same);
    await appendMessage("t1", "user", same);

    const thread = await getThread("t1");
    expect(thread!.messages).toHaveLength(2);
    const [first, second] = thread!.messages.map((m) => m.content);
    expect(first).not.toBe(second);
    expect(await getBlob(first)).toBe(same);
    expect(await getBlob(second)).toBe(same);
  });

  it("does not collide across threads", async () => {
    const same = "q".repeat(BLOB_THRESHOLD + 1);
    await appendMessage("t1", "user", same);
    await appendMessage("t2", "user", same);

    const [t1, t2] = [await getThread("t1"), await getThread("t2")];
    expect(t1!.messages[0].content).not.toBe(t2!.messages[0].content);
  });

  it("produces refs containing no whitespace", async () => {
    const large = "x".repeat(BLOB_THRESHOLD + 1);
    await appendMessage("C123:1699999999.000100", "user", large);
    await appendMessage("has spaces", "user", large);

    for (const id of ["C123:1699999999.000100", "has spaces"]) {
      const ref = (await getThread(id))!.messages[0].content;
      expect(ref).toMatch(/^\$blob:\S+$/);
      expect(await resolveRefs(ref)).toBe(large);
    }
  });

  it("stores blobs with a TTL longer than the default agent-output TTL", async () => {
    const large = "x".repeat(BLOB_THRESHOLD + 1);
    await appendMessage("t1", "user", large);

    const ref = (await getThread("t1"))!.messages[0].content;
    const entry = store.get(ref.replace("$blob:", ""))!;
    expect(entry.ex).toBeGreaterThan(3600);
  });

  it("preserves metadata from getOrCreateThread", async () => {
    await getOrCreateThread("t1", { userId: "u1" });
    await appendMessage("t1", "user", "hi");

    const thread = await getThread("t1");
    expect(thread?.metadata).toEqual({ userId: "u1" });
  });
});
