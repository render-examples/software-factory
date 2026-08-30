import { describe, it, expect } from "vitest";
import { createApp } from "./server.js";

describe("GET /ping", () => {
  it("responds 200 with pong and an ISO timestamp", async () => {
    const res = await createApp().request("/ping");
    expect(res.status).toBe(200);

    const body = (await res.json()) as { pong: boolean; timestamp: string };
    expect(body.pong).toBe(true);
    expect(typeof body.timestamp).toBe("string");
    expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);
  });
});
