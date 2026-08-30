import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const store = new Map<string, { value: string; ex?: number }>();
let failStorage = false;
const startTask = vi.fn();

vi.mock("../../sdk/redis.js", () => ({
  kv: async () => {
    if (failStorage) throw new Error("redis unavailable");
    return {
      get: async (key: string) => store.get(key)?.value ?? null,
      set: async (key: string, value: string, opts?: { EX?: number }) => {
        store.set(key, { value, ex: opts?.EX });
      },
      del: async (key: string) => {
        store.delete(key);
      },
    };
  },
}));

vi.mock("@renderinc/sdk", () => ({
  Render: class {
    workflows = { startTask };
  },
}));

import { dispatchWorkflowTask, DISPATCH_BLOB_TTL_SECONDS } from "./dispatch.js";
import { getBlob, BLOB_THRESHOLD } from "#factory-sdk/blobs";

const LARGE = "x".repeat(BLOB_THRESHOLD + 1);

/** First payload argument handed to startTask. */
function dispatchedPayload(): any {
  return startTask.mock.calls[0][1][0];
}

beforeEach(() => {
  store.clear();
  failStorage = false;
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

describe("dispatchWorkflowTask outcomes", () => {
  it("returns no-slug and does not dispatch when the slug is unset", async () => {
    delete process.env.RENDER_WORKFLOW_SLUG;
    const result = await dispatchWorkflowTask("assistant", { message: "hi" });

    expect(result).toEqual({ ok: false, reason: "no-slug", taskName: "assistant" });
    expect(startTask).not.toHaveBeenCalled();
  });

  it("prefixes the slug and wraps the payload in an argument array", async () => {
    const result = await dispatchWorkflowTask("assistant", { message: "hi", threadId: "t1" });

    expect(result).toEqual({ ok: true, taskName: "assistant" });
    expect(startTask).toHaveBeenCalledWith("acme/factory/assistant", [
      { message: "hi", threadId: "t1" },
    ]);
  });

  it("returns an error result when startTask throws", async () => {
    const boom = new Error("boom");
    startTask.mockRejectedValue(boom);

    const result = await dispatchWorkflowTask("assistant", { message: "hi" });
    expect(result).toEqual({
      ok: false,
      reason: "error",
      taskName: "assistant",
      error: boom,
    });
  });
});

describe("dispatchWorkflowTask blob-capping", () => {
  it("caps an oversized message and round-trips through the blob store", async () => {
    await dispatchWorkflowTask("assistant", { message: LARGE, threadId: "t1" });

    const payload = dispatchedPayload();
    expect(payload.message).toMatch(/^\$blob:/);
    expect(payload.threadId).toBe("t1");
    expect(await getBlob(payload.message)).toBe(LARGE);
  });

  it("leaves a small message inline and never touches storage", async () => {
    await dispatchWorkflowTask("assistant", { message: "small" });
    expect(dispatchedPayload().message).toBe("small");
    expect(store.size).toBe(0);
  });

  it("caps issue.body and comment.body on issue events", async () => {
    await dispatchWorkflowTask("spec-to-pr", {
      kind: "issue",
      issue: { number: 1, title: "keep me", body: LARGE },
      comment: { body: LARGE, user: "u" },
    });

    const payload = dispatchedPayload();
    expect(payload.issue.body).toMatch(/^\$blob:/);
    expect(payload.comment.body).toMatch(/^\$blob:/);
    expect(await getBlob(payload.issue.body)).toBe(LARGE);
    expect(await getBlob(payload.comment.body)).toBe(LARGE);
    // Sibling fields survive untouched.
    expect(payload.issue.title).toBe("keep me");
    expect(payload.comment.user).toBe("u");
  });

  it("caps pull.body on pull events", async () => {
    await dispatchWorkflowTask("pr-review", {
      kind: "pull",
      pull: { number: 7, title: "t", body: LARGE, head: "agent/x" },
    });

    const payload = dispatchedPayload();
    expect(payload.pull.body).toMatch(/^\$blob:/);
    expect(payload.pull.head).toBe("agent/x");
    expect(await getBlob(payload.pull.body)).toBe(LARGE);
  });

  it("handles issue events with no comment", async () => {
    await dispatchWorkflowTask("spec-to-pr", {
      kind: "issue",
      issue: { body: LARGE },
    });
    expect(dispatchedPayload().comment).toBeUndefined();
  });

  it("does not mutate the caller's payload", async () => {
    const payload = { kind: "issue", issue: { body: LARGE } };
    await dispatchWorkflowTask("spec-to-pr", payload);
    expect(payload.issue.body).toBe(LARGE);
  });

  it("stores blobs with the dispatch TTL", async () => {
    await dispatchWorkflowTask("assistant", { message: LARGE });
    const key = dispatchedPayload().message.replace("$blob:", "");
    expect(store.get(key)?.ex).toBe(DISPATCH_BLOB_TTL_SECONDS);
  });

  it("dispatches the raw payload when blob storage is unavailable", async () => {
    failStorage = true;
    const result = await dispatchWorkflowTask("assistant", { message: LARGE });

    expect(result.ok).toBe(true);
    expect(dispatchedPayload().message).toBe(LARGE);
  });

  it("passes through payloads with no cappable fields", async () => {
    await dispatchWorkflowTask("spec-to-pr", { kind: "skip", event: "issues" });
    expect(dispatchedPayload()).toEqual({ kind: "skip", event: "issues" });
  });
});
