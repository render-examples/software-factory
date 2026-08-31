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
    expire: async (key: string, seconds: number) => {
      const entry = store.get(key);
      if (!entry) return 0;
      entry.ex = seconds;
      return 1;
    },
  }),
}));

import {
  putBlob,
  getBlob,
  delBlob,
  isBlobRef,
  requireBlob,
  maybePutBlob,
  BLOB_THRESHOLD,
} from "../blobs.js";

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

  it("refreshes artifact lifetime when it is read", async () => {
    const ref = await putBlob("run1", "step", "data", 1);
    const key = ref.replace("$blob:", "");
    await getBlob(ref);
    expect(store.get(key)?.ex).toBe(7 * 24 * 60 * 60);
  });

  it("returns null for unknown ref", async () => {
    const content = await getBlob("$blob:blob:unknown:step:abc");
    expect(content).toBeNull();
  });

  it("rejects references outside the blob namespace", async () => {
    store.set("thread:private", {
      value: JSON.stringify({ messages: ["secret"] }),
    });
    expect(await getBlob("$blob:thread:private")).toBeNull();
  });

  it("uses opaque capabilities instead of content-derived keys", async () => {
    const first = await putBlob("run1", "step", "same");
    const second = await putBlob("run1", "step", "same");
    expect(first).not.toBe(second);
    expect(isBlobRef(first)).toBe(true);
  });

  it("fails closed for an invalid or expired required reference", async () => {
    await expect(
      requireBlob("$blob:blob:unknown:step:abc"),
    ).rejects.toThrow(/invalid or expired/);
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
