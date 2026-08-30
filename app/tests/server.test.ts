import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const store = new Map<string, { value: string; ex?: number }>();
const startTask = vi.fn();

vi.mock("../../sdk/redis.js", () => ({
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

vi.mock("@renderinc/sdk", () => ({
  Render: class {
    workflows = { startTask };
  },
}));

import { createApp } from "../gateway/server.js";
import { getThread } from "#factory-sdk/threads";
import { getBlob, BLOB_THRESHOLD } from "#factory-sdk/blobs";

const LARGE = "x".repeat(BLOB_THRESHOLD + 1);

function post(threadId: string, body: unknown) {
  return createApp().request(`/threads/${threadId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function dispatchedPayload(): any {
  return startTask.mock.calls[0][1][0];
}

beforeEach(() => {
  store.clear();
  startTask.mockReset();
  startTask.mockResolvedValue({ id: "run-1" });
  process.env.RENDER_WORKFLOW_SLUG = "acme/factory";
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.RENDER_WORKFLOW_SLUG;
});

describe("GET /health", () => {
  it("reports ok", async () => {
    const res = await createApp().request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});

describe("POST /threads/:id/messages", () => {
  it("rejects a missing content field", async () => {
    const res = await post("t1", { userId: "u1" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "content is required" });
    expect(startTask).not.toHaveBeenCalled();
  });

  it("accepts a message and dispatches the assistant task", async () => {
    const res = await post("t1", { content: "hello", userId: "u1" });

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ threadId: "t1", status: "accepted" });
    expect(startTask).toHaveBeenCalledWith("acme/factory/assistant", [
      { message: "hello", threadId: "t1" },
    ]);
  });

  it("persists the user message to the thread", async () => {
    await post("t1", { content: "hello", userId: "u1" });

    const thread = await getThread("t1");
    expect(thread?.messages).toMatchObject([{ role: "user", content: "hello" }]);
    expect(thread?.metadata).toEqual({ userId: "u1" });
  });

  it("blob-caps an oversized message before dispatch", async () => {
    const res = await post("t1", { content: LARGE });
    expect(res.status).toBe(202);

    const payload = dispatchedPayload();
    expect(payload.message).toMatch(/^\$blob:/);
    expect(await getBlob(payload.message)).toBe(LARGE);
  });

  it("still accepts the request when no workflow slug is configured", async () => {
    delete process.env.RENDER_WORKFLOW_SLUG;
    const res = await post("t1", { content: "hello" });

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ threadId: "t1", status: "accepted" });
    expect(startTask).not.toHaveBeenCalled();
    expect((await getThread("t1"))?.messages).toHaveLength(1);
  });

  it("returns 502 when dispatch fails", async () => {
    startTask.mockRejectedValue(new Error("boom"));
    const res = await post("t1", { content: "hello" });

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "dispatch failed" });
  });

  it("defaults userId to anonymous", async () => {
    await post("t1", { content: "hello" });
    expect((await getThread("t1"))?.metadata).toEqual({ userId: "anonymous" });
  });
});
