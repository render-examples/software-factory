import { describe, it, expect, vi, beforeEach } from "vitest";

const store = new Map<string, { value: string; ex?: number }>();

vi.mock("./redis.js", () => ({
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

import {
  putBlob,
  getBlob,
  delBlob,
  resolveRefs,
  maybePutBlob,
  BLOB_THRESHOLD,
} from "./blobs.js";

beforeEach(() => {
  store.clear();
});

describe("putBlob / getBlob", () => {
  it("stores content and returns a $blob: ref", async () => {
    const ref = await putBlob("run1", "researcher", "hello world");
    expect(ref).toMatch(/^\$blob:blob:run1:researcher:[a-f0-9]+$/);

    const content = await getBlob(ref);
    expect(content).toBe("hello world");
  });

  it("stores with TTL", async () => {
    const ref = await putBlob("run1", "step", "data", 300);
    const key = ref.replace("$blob:", "");
    expect(store.get(key)?.ex).toBe(300);
  });

  it("returns null for unknown ref", async () => {
    const content = await getBlob("$blob:blob:unknown:step:abc");
    expect(content).toBeNull();
  });
});

describe("delBlob", () => {
  it("deletes a stored blob", async () => {
    const ref = await putBlob("run1", "step", "to-delete");
    expect(await getBlob(ref)).toBe("to-delete");

    await delBlob(ref);
    expect(await getBlob(ref)).toBeNull();
  });
});

describe("resolveRefs", () => {
  it("replaces refs with stored content", async () => {
    const ref1 = await putBlob("r1", "research", "Research findings here");
    const ref2 = await putBlob("r1", "plan", "Implementation plan");

    const input = `Title\n\n${ref1}\n\nPlan:\n${ref2}`;
    const resolved = await resolveRefs(input);

    expect(resolved).toBe(
      "Title\n\nResearch findings here\n\nPlan:\nImplementation plan",
    );
  });

  it("leaves text without refs unchanged", async () => {
    const text = "Just a regular message with no refs";
    expect(await resolveRefs(text)).toBe(text);
  });

  it("leaves unresolvable refs in place", async () => {
    const text = "Prefix $blob:blob:gone:step:abc suffix";
    expect(await resolveRefs(text)).toBe(text);
  });

  it("handles duplicate refs", async () => {
    const ref = await putBlob("r1", "step", "content");
    const input = `${ref} and ${ref}`;
    const resolved = await resolveRefs(input);
    expect(resolved).toBe("content and content");
  });
});

describe("maybePutBlob", () => {
  it("returns content inline when below threshold", async () => {
    const small = "x".repeat(BLOB_THRESHOLD - 1);
    const result = await maybePutBlob("r1", "step", small);
    expect(result).toBe(small);
    expect(store.size).toBe(0);
  });

  it("returns content inline at exact threshold", async () => {
    const exact = "x".repeat(BLOB_THRESHOLD);
    const result = await maybePutBlob("r1", "step", exact);
    expect(result).toBe(exact);
    expect(store.size).toBe(0);
  });

  it("stores and returns ref when above threshold", async () => {
    const large = "x".repeat(BLOB_THRESHOLD + 1);
    const result = await maybePutBlob("r1", "step", large);
    expect(result).toMatch(/^\$blob:/);
    expect(store.size).toBe(1);

    const resolved = await getBlob(result);
    expect(resolved).toBe(large);
  });
});
