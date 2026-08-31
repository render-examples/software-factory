import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { ping } = vi.hoisted(() => ({ ping: vi.fn() }));

vi.mock("../../sdk/redis.js", () => ({
  kv: async () => ({ ping }),
}));

import { createApp } from "../gateway/server.js";

beforeEach(() => {
  ping.mockReset().mockResolvedValue("PONG");
  process.env.FACTORY_REPO = "acme/factory";
  process.env.FACTORY_GITHUB_ACTORS = "maintainer";
});

afterEach(() => {
  delete process.env.FACTORY_REPO;
  delete process.env.FACTORY_GITHUB_ACTORS;
});

describe("factory gateway", () => {
  it("reports health", async () => {
    const response = await createApp().request("/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("reports Key Value readiness separately", async () => {
    const app = createApp();
    expect((await app.request("/ready")).status).toBe(200);

    ping.mockRejectedValue(new Error("offline"));
    const unavailable = await app.request("/ready");
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ status: "unavailable" });
  });

  it("does not expose the removed chat surfaces", async () => {
    const app = createApp();
    expect((await app.request("/threads/t1/messages", { method: "POST" })).status)
      .toBe(404);
    expect((await app.request("/channels/slack", { method: "POST" })).status)
      .toBe(404);
  });
});
