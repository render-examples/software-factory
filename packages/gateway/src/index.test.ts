import { describe, it, expect } from "vitest";
import type { ConnectorSpec, ConnectorContext, WebhookMatch } from "../src/index.js";
import { createGatewayApp } from "../src/index.js";
import type { GatewayOptions } from "../src/index.js";
import { createMemoryStore, MemoryCancelStore, type RunStore } from "@render-agents/store";

/**
 * Build a minimal `AgentRuntime` satisfying the full interface for route tests.
 * Routes only touch `store` (+ optional cancelStore), but the type requires the
 * complete composition root, so we supply no-op stand-ins for the rest.
 */
function makeTestRuntime(store: RunStore): GatewayOptions["runtime"] {
  return {
    store,
    tracer: { onStart: () => {}, onEnd: () => {} },
    model: { complete: async () => ({ content: [], usage: { inputTokens: 0, outputTokens: 0 }, stopReason: "end_turn" }) },
    runners: { get: () => { throw new Error("no runner"); }, has: () => false },
    hooks: { get: () => { throw new Error("no hook"); }, has: () => false, ids: () => [] },
    contextManager: { prepare: async (m) => m },
    cancelStore: new MemoryCancelStore(),
    agentDefinitions: new Map(),
    toolSources: new Map(),
  };
}

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
      runtime: makeTestRuntime(store),
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
      runtime: makeTestRuntime(store),
      disableAuth: true,
    });

    const res = await app.request("/runs/nonexistent");
    expect(res.status).toBe(404);
  });

  it("workflow dispatch returns 404 for unknown workflow", async () => {
    const store = createMemoryStore();
    await store.init();
    const app = createGatewayApp({
      runtime: makeTestRuntime(store),
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
