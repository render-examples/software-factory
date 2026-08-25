import { describe, it, expect } from "vitest";
import type { WorkflowDefinition } from "@render-factory/sdk";
import { createTestRuntime } from "@render-factory/sdk/testing";
import { createGatewayApp } from "../src/index.js";
import type { OAuthProviderConfig } from "../src/routes/oauth.js";

function stubWorkflow(name: string): WorkflowDefinition {
  return {
    name,
    options: {},
    async dispatch() { return { id: `${name}-run`, workflow: name, status: "completed", totalCostUsd: 0, startedAt: new Date().toISOString() } as never; },
    async drive() { /* unused */ },
  };
}

const githubProvider: OAuthProviderConfig = {
  clientId: "id", clientSecret: "secret",
  authorizeUrl: "https://example.test/authorize", tokenUrl: "https://example.test/token",
  scopes: ["repo"],
};

describe("UI read endpoints — GET /workflows", () => {
  it("lists registered workflow names and the default", async () => {
    const runtime = await createTestRuntime();
    const workflows = new Map([["code-review", stubWorkflow("code-review")], ["deploy", stubWorkflow("deploy")]]);
    const app = createGatewayApp({ runtime, workflows, defaultWorkflow: "code-review", disableAuth: true });

    const res = await app.request("/workflows");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.workflows.map((w: { name: string }) => w.name).sort()).toEqual(["code-review", "deploy"]);
    expect(body.defaultWorkflow).toBe("code-review");
  });

  it("returns an empty list when no workflows are registered", async () => {
    const runtime = await createTestRuntime();
    const app = createGatewayApp({ runtime, disableAuth: true });
    const { workflows } = await (await app.request("/workflows")).json();
    expect(workflows).toEqual([]);
  });
});

describe("UI read endpoints — GET /connections", () => {
  it("404s when OAuth is not configured", async () => {
    const runtime = await createTestRuntime();
    const app = createGatewayApp({ runtime, disableAuth: true });
    expect((await app.request("/connections")).status).toBe(404);
  });

  it("reports configured providers and the caller's connected status", async () => {
    const runtime = await createTestRuntime();
    const oauthProviders = new Map([["github", githubProvider]]);
    // disableAuth → the caller is the operator; the connections shown are always
    // the authenticated caller's own (userId from auth, never a query param, CR-D1).
    const app = createGatewayApp({ runtime, oauthProviders, disableAuth: true });

    // Nothing connected yet.
    const anon = await (await app.request("/connections")).json();
    expect(anon.providers).toEqual([{ provider: "github", connected: false, scopes: undefined, expiresAt: undefined }]);

    const now = new Date().toISOString();
    // A connection owned by a *different* user is NOT visible to this caller.
    await runtime.oauthStore.upsertConnection({
      id: "u2:github", userId: "u2", provider: "github",
      accessToken: "tok2", scopes: ["repo"], createdAt: now, updatedAt: now,
    });
    const stillNone = await (await app.request("/connections")).json();
    expect(stillNone.providers[0].connected).toBe(false);

    // Seed a connection for the caller (operator), then it reports connected.
    await runtime.oauthStore.upsertConnection({
      id: "operator:github", userId: "operator", provider: "github",
      accessToken: "tok", scopes: ["repo"], createdAt: now, updatedAt: now,
    });
    const mine = await (await app.request("/connections")).json();
    expect(mine.providers).toEqual([{ provider: "github", connected: true, scopes: ["repo"], expiresAt: undefined }]);
  });
});

describe("UI shell hardening headers", () => {
  it("serves /ui with CSP and browser security headers", async () => {
    const runtime = await createTestRuntime();
    const app = createGatewayApp({ runtime, disableAuth: true });
    const res = await app.request("/ui");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });
});
