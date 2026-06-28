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

function buildApp() {
  const store = createMemoryStore();
  const providers = new Map([["github", provider()]]);
  const app = new Hono();
  app.route("/", oauthRoutes({ providers, baseUrl: "http://gw", oauthStore: store, fetchImpl: tokenFetch() }));
  return { app, store };
}

describe("gateway OAuth — connect / persist / revoke", () => {
  it("authorize → callback exchanges the code and persists the connection", async () => {
    const { app, store } = buildApp();

    // Authorize redirects to the provider with a signed state.
    const authRes = await app.request("/oauth/github/authorize?userId=u1", { redirect: "manual" });
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

    // Revoke removes it.
    const delRes = await app.request("/oauth/github?userId=u1", { method: "DELETE" });
    expect(delRes.status).toBe(200);
    expect(await store.getConnection("u1", "github")).toBeUndefined();
  });

  it("rejects a tampered/invalid state", async () => {
    const { app } = buildApp();
    const res = await app.request("/oauth/github/callback?code=abc&state=not.valid");
    expect(res.status).toBe(403);
  });

  it("requires userId to authorize", async () => {
    const { app } = buildApp();
    const res = await app.request("/oauth/github/authorize", { redirect: "manual" });
    expect(res.status).toBe(400);
  });
});
