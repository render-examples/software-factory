import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { createMemoryStore } from "@render-agents/store";
import { oauthRoutes, type OAuthProviderConfig } from "../src/index.js";

function provider(): OAuthProviderConfig {
  return {
    clientId: "cid",
    clientSecret: "secret",
    authorizeUrl: "https://gh.example/authorize",
    tokenUrl: "https://gh.example/token",
    scopes: ["repo"],
  };
}

/** Mock token endpoint returning a standard token response. */
function tokenFetch(): typeof fetch {
  return (async (url: string | URL | Request) => {
    const u = typeof url === "string" ? url : url.toString();
    if (u.includes("/token")) {
      return new Response(
        JSON.stringify({ access_token: "AT-123", refresh_token: "RT-456", expires_in: 3600, scope: "repo" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

function buildApp(userId = "u1") {
  const store = createMemoryStore();
  const providers = new Map([["github", provider()]]);
  const app = new Hono();
  // Stand in for the auth middleware: the OAuth routes derive the userId from the
  // principal (never a query param), so seed one for the test.
  app.use("*", async (c, next) => {
    c.set("principal", { userId, role: "user" });
    await next();
  });
  app.route("/", oauthRoutes({ providers, baseUrl: "http://gw", oauthStore: store, fetchImpl: tokenFetch() }));
  return { app, store };
}

describe("gateway OAuth — connect / persist / revoke", () => {
  it("authorize → callback exchanges the code and persists the connection", async () => {
    const { app, store } = buildApp("u1");

    // Authorize redirects to the provider with a signed state carrying the
    // auth-derived userId (no `?userId=` query — that would be spoofable, CR-D1).
    const authRes = await app.request("/oauth/github/authorize", { redirect: "manual" });
    expect(authRes.status).toBe(302);
    const location = authRes.headers.get("location")!;
    const state = new URL(location).searchParams.get("state")!;
    expect(state).toBeTruthy();

    // Callback exchanges the code and stores the connection for the user.
    const cbRes = await app.request(`/oauth/github/callback?code=abc&state=${encodeURIComponent(state)}`);
    expect(cbRes.status).toBe(200);
    expect(await cbRes.json()).toMatchObject({ status: "connected", provider: "github", userId: "u1" });

    const conn = await store.getConnection("u1", "github");
    expect(conn?.accessToken).toBe("AT-123");
    expect(conn?.refreshToken).toBe("RT-456");
    expect(conn?.expiresAt).toBeTruthy();

    // Revoke removes it — scoped to the caller (no `?userId=`).
    const delRes = await app.request("/oauth/github", { method: "DELETE" });
    expect(delRes.status).toBe(200);
    expect(await store.getConnection("u1", "github")).toBeUndefined();
  });

  it("rejects a tampered/invalid state", async () => {
    const { app } = buildApp();
    const res = await app.request("/oauth/github/callback?code=abc&state=not.valid");
    expect(res.status).toBe(403);
  });

  it("derives the user from auth — authorize needs no userId query", async () => {
    const { app } = buildApp("alice");
    const res = await app.request("/oauth/github/authorize", { redirect: "manual" });
    expect(res.status).toBe(302);
    const state = new URL(res.headers.get("location")!).searchParams.get("state")!;
    expect(state).toBeTruthy();
  });
});

describe("operator UI (/ui)", () => {
  it("serves the SPA shell + hashed assets without auth", async () => {
    const { createGatewayApp } = await import("../src/index.js");
    const { createMemoryStore, MemoryCancelStore } = await import("@render-agents/store");
    const store = createMemoryStore();
    await store.init();
    const runtime = {
      store, threadStore: store, oauthStore: store, oauthRefreshers: new Map(),
      tracer: { onStart: () => {}, onEnd: () => {} },
      model: { complete: async () => ({ content: [], usage: { inputTokens: 0, outputTokens: 0 }, stopReason: "end_turn" }) },
      runners: { get: () => { throw new Error("no"); }, has: () => false },
      hooks: { get: () => { throw new Error("no"); }, has: () => false, ids: () => [] },
      contextManager: { prepare: async (m: unknown) => m },
      cancelStore: new MemoryCancelStore(), agentDefinitions: new Map(), toolSources: new Map(),
    } as unknown as Parameters<typeof createGatewayApp>[0]["runtime"];

    // Auth ENABLED — the UI shell must still load (registered before auth).
    process.env.RENDER_AGENTS_API_KEY = "test-key";
    const app = createGatewayApp({ runtime });

    const shell = await app.request("/ui");
    expect(shell.status).toBe(200);
    expect(shell.headers.get("content-type")).toContain("text/html");
    const html = await shell.text();
    expect(html).toContain('id="root"');

    // The shell references hashed JS/CSS assets under /ui/assets/ — fetch one and
    // confirm it serves with the right content type, unauthenticated.
    const assetMatch = html.match(/\/ui\/assets\/[\w.-]+\.js/);
    expect(assetMatch).not.toBeNull();
    const asset = await app.request(assetMatch![0]);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("javascript");

    // Path-traversal guard on the asset route.
    expect((await app.request("/ui/assets/..%2f..%2fpackage.json")).status).toBe(404);

    // SPA fallback for client routes.
    expect((await app.request("/ui/runs/abc")).status).toBe(200);

    // Data routes require the key via the Authorization header.
    expect((await app.request("/runs")).status).toBe(401);
    expect((await app.request("/runs", { headers: { authorization: "Bearer test-key" } })).status).toBe(200);
    // The `?key=` fallback is rejected on non-SSE routes so the key can't leak
    // via logs/history/Referer (CR-05). It stays available for EventSource paths.
    expect((await app.request("/runs?key=test-key")).status).toBe(401);
    delete process.env.RENDER_AGENTS_API_KEY;
  });
});

describe("gateway auth carve-outs (CR-01/CR-05)", () => {
  async function buildAuthedGateway() {
    const { createGatewayApp } = await import("../src/index.js");
    const { createMemoryStore, MemoryCancelStore } = await import("@render-agents/store");
    const store = createMemoryStore();
    await store.init();
    const runtime = {
      store, threadStore: store, oauthStore: store, oauthRefreshers: new Map(),
      tracer: { onStart: () => {}, onEnd: () => {} },
      model: { complete: async () => ({ content: [], usage: { inputTokens: 0, outputTokens: 0 }, stopReason: "end_turn" }) },
      runners: { get: () => { throw new Error("no"); }, has: () => false },
      hooks: { get: () => { throw new Error("no"); }, has: () => false, ids: () => [] },
      contextManager: { prepare: async (m: unknown) => m },
      cancelStore: new MemoryCancelStore(), agentDefinitions: new Map(), toolSources: new Map(),
      workflows: new Map(), deltaBus: { publish: () => {}, subscribe: () => () => {} },
      scheduleStore: store, jobQueue: { countByStatus: async () => ({ queued: 0, running: 0, completed: 0, failed: 0 }) },
    } as unknown as Parameters<typeof createGatewayApp>[0]["runtime"];

    const webhook = { name: "github", match: () => null, parse: async () => ({}) };
    process.env.RENDER_AGENTS_API_KEY = "test-key";
    const app = createGatewayApp({
      runtime,
      oauthProviders: new Map([["github", provider()]]),
      webhooks: new Map([["github", webhook]]),
    });
    return app;
  }

  it("OAuth callback is reachable without the operator key (authed by signed state)", async () => {
    const app = await buildAuthedGateway();
    // No code/state → 400 from the handler (NOT 401): it got past auth.
    const res = await app.request("/oauth/github/callback");
    expect(res.status).toBe(400);
    delete process.env.RENDER_AGENTS_API_KEY;
  });

  it("inbound webhooks are reachable without the operator key (authed by adapter)", async () => {
    const app = await buildAuthedGateway();
    // Adapter returns no match → 400 from the handler (NOT 401): it got past auth.
    const res = await app.request("/webhooks/github", { method: "POST" });
    expect(res.status).toBe(400);
    delete process.env.RENDER_AGENTS_API_KEY;
  });

  it("OAuth authorize still requires the operator key", async () => {
    const app = await buildAuthedGateway();
    expect((await app.request("/oauth/github/authorize?userId=u1")).status).toBe(401);
    delete process.env.RENDER_AGENTS_API_KEY;
  });
});
