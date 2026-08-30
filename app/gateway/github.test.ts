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

import { githubHandler } from "./github.js";
import { getBlob, BLOB_THRESHOLD } from "#factory-sdk/blobs";

const SECRET = "github-test-secret";
const LARGE = "x".repeat(BLOB_THRESHOLD + 1);

const REPO = {
  name: "factory",
  owner: { login: "acme" },
  full_name: "acme/factory",
  default_branch: "main",
};

/** POST /github with a valid sha256 HMAC over the raw body. */
function post(event: string, payload: unknown) {
  const body = JSON.stringify(payload);
  const sig = "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex");

  return githubHandler().request("/github", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-hub-signature-256": sig,
    },
    body,
  });
}

function issuePayload(body: string, extra: Record<string, unknown> = {}) {
  return {
    action: "opened",
    repository: REPO,
    sender: { login: "dev", type: "User" },
    issue: {
      number: 42,
      title: "Add a feature",
      body,
      labels: [],
      user: { login: "dev" },
      html_url: "https://github.com/acme/factory/issues/42",
    },
    ...extra,
  };
}

function pullPayload(body: string) {
  return {
    action: "opened",
    repository: REPO,
    sender: { login: "dev", type: "User" },
    pull_request: {
      number: 7,
      title: "A pull request",
      body,
      head: { ref: "agent/issue-42" },
      base: { ref: "main" },
      user: { login: "dev" },
      html_url: "https://github.com/acme/factory/pull/7",
      draft: false,
    },
  };
}

function dispatchedTask(): string {
  return startTask.mock.calls[0][0];
}

function dispatchedPayload(): any {
  return startTask.mock.calls[0][1][0];
}

beforeEach(() => {
  store.clear();
  startTask.mockReset();
  startTask.mockResolvedValue({ id: "run-1" });
  process.env.GITHUB_WEBHOOK_SECRET = SECRET;
  process.env.RENDER_WORKFLOW_SLUG = "acme/factory";
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.GITHUB_WEBHOOK_SECRET;
  delete process.env.RENDER_WORKFLOW_SLUG;
});

describe("github signature verification", () => {
  it("rejects a request with a bad signature", async () => {
    const res = await githubHandler().request("/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "issues",
        "x-hub-signature-256": "sha256=deadbeef",
      },
      body: JSON.stringify(issuePayload("hi")),
    });

    expect(res.status).toBe(401);
    expect(startTask).not.toHaveBeenCalled();
  });
});

describe("POST /github routing", () => {
  it("ignores unsupported event types", async () => {
    const res = await post("push", { repository: REPO });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: true });
    expect(startTask).not.toHaveBeenCalled();
  });

  it("skips events that cannot be normalized", async () => {
    const res = await post("issues", { action: "opened" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, skipped: true });
    expect(startTask).not.toHaveBeenCalled();
  });

  it("dispatches spec-to-pr for issues", async () => {
    const res = await post("issues", issuePayload("please add a feature"));

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ dispatched: "spec-to-pr" });
    expect(dispatchedTask()).toBe("acme/factory/spec-to-pr");
  });

  it("dispatches pr-review for pull_request", async () => {
    const res = await post("pull_request", pullPayload("a description"));

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ dispatched: "pr-review" });
    expect(dispatchedTask()).toBe("acme/factory/pr-review");
  });

  it("dispatches pr-fix for pull_request_review", async () => {
    const res = await post("pull_request_review", pullPayload("a description"));

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ dispatched: "pr-fix" });
    expect(dispatchedTask()).toBe("acme/factory/pr-fix");
  });
});

describe("POST /github status mapping", () => {
  it("returns 503 when no workflow slug is configured", async () => {
    delete process.env.RENDER_WORKFLOW_SLUG;
    const res = await post("issues", issuePayload("hi"));

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "RENDER_WORKFLOW_SLUG not set" });
    expect(startTask).not.toHaveBeenCalled();
  });

  it("returns 502 when dispatch fails", async () => {
    startTask.mockRejectedValue(new Error("boom"));
    const res = await post("issues", issuePayload("hi"));

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "dispatch failed" });
  });
});

describe("POST /github blob-capping", () => {
  it("caps an oversized issue body", async () => {
    const res = await post("issues", issuePayload(LARGE));
    expect(res.status).toBe(202);

    const payload = dispatchedPayload();
    expect(payload.issue.body).toMatch(/^\$blob:/);
    expect(await getBlob(payload.issue.body)).toBe(LARGE);
    // Other fields are untouched.
    expect(payload.issue.title).toBe("Add a feature");
    expect(payload.repo.fullName).toBe("acme/factory");
  });

  it("caps an oversized comment body", async () => {
    const res = await post(
      "issue_comment",
      issuePayload("small issue body", {
        action: "created",
        comment: { body: LARGE, user: { login: "dev" } },
      }),
    );
    expect(res.status).toBe(202);

    const payload = dispatchedPayload();
    expect(payload.issue.body).toBe("small issue body");
    expect(payload.comment.body).toMatch(/^\$blob:/);
    expect(await getBlob(payload.comment.body)).toBe(LARGE);
  });

  it("caps an oversized pull request body", async () => {
    const res = await post("pull_request", pullPayload(LARGE));
    expect(res.status).toBe(202);

    const payload = dispatchedPayload();
    expect(payload.pull.body).toMatch(/^\$blob:/);
    expect(payload.pull.head).toBe("agent/issue-42");
    expect(await getBlob(payload.pull.body)).toBe(LARGE);
  });

  it("leaves small bodies inline", async () => {
    await post("issues", issuePayload("short"));
    expect(dispatchedPayload().issue.body).toBe("short");
    expect(store.size).toBe(0);
  });
});
