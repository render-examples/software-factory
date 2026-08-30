import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";

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

import { slackHandler } from "../gateway/slack.js";
import { getThread } from "#factory-sdk/threads";
import { getBlob, BLOB_THRESHOLD } from "#factory-sdk/blobs";

const SECRET = "slack-test-secret";
const LARGE = "x".repeat(BLOB_THRESHOLD + 1);

function post(payload: unknown, extraHeaders: Record<string, string> = {}) {
  const body = JSON.stringify(payload);
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig =
    "v0=" + createHmac("sha256", SECRET).update(`v0:${ts}:${body}`).digest("hex");

  return slackHandler().request("/slack", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": ts,
      "x-slack-signature": sig,
      ...extraHeaders,
    },
    body,
  });
}

function mention(text: string, overrides: Record<string, unknown> = {}) {
  return {
    type: "event_callback",
    event: {
      type: "app_mention",
      channel: "C123",
      user: "U1",
      text,
      ts: "1699999999.000100",
      ...overrides,
    },
  };
}

function dispatchedPayload(): any {
  return startTask.mock.calls[0][1][0];
}

beforeEach(() => {
  store.clear();
  startTask.mockReset();
  startTask.mockResolvedValue({ id: "run-1" });
  process.env.SLACK_SIGNING_SECRET = SECRET;
  process.env.RENDER_WORKFLOW_SLUG = "acme/factory";
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.SLACK_SIGNING_SECRET;
  delete process.env.RENDER_WORKFLOW_SLUG;
});

describe("slack signature verification", () => {
  it("rejects a request with a bad signature", async () => {
    const res = await slackHandler().request("/slack", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": Math.floor(Date.now() / 1000).toString(),
        "x-slack-signature": "v0=deadbeef",
      },
      body: JSON.stringify(mention("hi")),
    });

    expect(res.status).toBe(401);
    expect(startTask).not.toHaveBeenCalled();
  });

  it("echoes a url_verification challenge", async () => {
    const res = await post({ type: "url_verification", challenge: "abc123" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: "abc123" });
  });
});

describe("POST /slack dispatch", () => {
  it("dispatches slack-assistant and strips the leading mention", async () => {
    const res = await post(mention("<@UBOT> deploy the app"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(startTask).toHaveBeenCalledWith("acme/factory/slack-assistant", [
      {
        message: "deploy the app",
        threadId: "C123:1699999999.000100",
        slackChannel: "C123",
        slackThreadTs: "1699999999.000100",
      },
    ]);
  });

  it("blob-caps an oversized message before dispatch", async () => {
    const res = await post(mention(`<@UBOT> ${LARGE}`));
    expect(res.status).toBe(200);

    const payload = dispatchedPayload();
    expect(payload.message).toMatch(/^\$blob:/);
    expect(await getBlob(payload.message)).toBe(LARGE);
  });

  it("persists the message to the thread", async () => {
    await post(mention("<@UBOT> hello"));

    const thread = await getThread("C123:1699999999.000100");
    expect(thread?.messages).toMatchObject([{ role: "user", content: "hello" }]);
  });

  it("uses the channel id as the thread id for DMs", async () => {
    await post(
      mention("hello", { type: "message", channel: "D999", channel_type: "im" }),
    );
    expect(dispatchedPayload().threadId).toBe("D999");
  });

  it("returns 200 even when dispatch fails", async () => {
    startTask.mockRejectedValue(new Error("boom"));
    const res = await post(mention("<@UBOT> hi"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("returns 200 when no workflow slug is configured", async () => {
    delete process.env.RENDER_WORKFLOW_SLUG;
    const res = await post(mention("<@UBOT> hi"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(startTask).not.toHaveBeenCalled();
  });

  it("ignores Slack retries", async () => {
    const res = await post(mention("<@UBOT> hi"), { "x-slack-retry-num": "1" });
    expect(res.status).toBe(200);
    expect(startTask).not.toHaveBeenCalled();
  });

  it("ignores bot messages", async () => {
    const res = await post(mention("hi", { bot_id: "B1" }));
    expect(res.status).toBe(200);
    expect(startTask).not.toHaveBeenCalled();
  });

  it("ignores plain channel messages that are not threaded", async () => {
    const res = await post(mention("hi", { type: "message" }));
    expect(res.status).toBe(200);
    expect(startTask).not.toHaveBeenCalled();
  });
});
