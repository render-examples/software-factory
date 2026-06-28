import { describe, it, expect } from "vitest";
import type { ConnectorSpec, ConnectorContext, WebhookMatch } from "../src/index.js";
import { createGatewayApp } from "../src/index.js";
import { createMemoryStore } from "@render-agents/store";

describe("@render-agents/gateway", () => {
  it("ConnectorSpec type is assignable", () => {
    const spec: ConnectorSpec = {
      key: "github",
      name: "GitHub",
      handle: async (_req: Request, _ctx: ConnectorContext): Promise<WebhookMatch | null> => {
        return { workflow: "code-review", trigger: "push" };
      },
    };
    expect(spec.key).toBe("github");
  });

  it("health endpoint returns ok without auth", async () => {
    const store = createMemoryStore();
    await store.init();
    const app = createGatewayApp({
      runtime: {
        store,
        tracer: { onStart: () => {}, onEnd: () => {} },
        model: { complete: async () => ({ content: [], usage: { inputTokens: 0, outputTokens: 0 }, stopReason: "end_turn" }) },
        runners: { get: () => { throw new Error("no runner"); }, has: () => false },
        hooks: { get: () => { throw new Error("no hook"); }, has: () => false, ids: () => [] },
        contextManager: { prepare: async (m) => m },
        toolSources: new Map(),
      },
      disableAuth: true,
    });

    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });

  it("run routes return 404 for unknown run", async () => {
    const store = createMemoryStore();
    await store.init();
    const app = createGatewayApp({
      runtime: {
        store,
        tracer: { onStart: () => {}, onEnd: () => {} },
        model: { complete: async () => ({ content: [], usage: { inputTokens: 0, outputTokens: 0 }, stopReason: "end_turn" }) },
        runners: { get: () => { throw new Error("no runner"); }, has: () => false },
        hooks: { get: () => { throw new Error("no hook"); }, has: () => false, ids: () => [] },
        contextManager: { prepare: async (m) => m },
        toolSources: new Map(),
      },
      disableAuth: true,
    });

    const res = await app.request("/runs/nonexistent");
    expect(res.status).toBe(404);
  });

  it("workflow dispatch returns 404 for unknown workflow", async () => {
    const store = createMemoryStore();
    await store.init();
    const app = createGatewayApp({
      runtime: {
        store,
        tracer: { onStart: () => {}, onEnd: () => {} },
        model: { complete: async () => ({ content: [], usage: { inputTokens: 0, outputTokens: 0 }, stopReason: "end_turn" }) },
        runners: { get: () => { throw new Error("no runner"); }, has: () => false },
        hooks: { get: () => { throw new Error("no hook"); }, has: () => false, ids: () => [] },
        contextManager: { prepare: async (m) => m },
        toolSources: new Map(),
      },
      disableAuth: true,
    });

    const res = await app.request("/workflows/unknown", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "test" }),
    });
    expect(res.status).toBe(404);
  });
});
