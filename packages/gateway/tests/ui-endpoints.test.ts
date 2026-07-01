import { describe, it, expect } from "vitest";
import type { WorkflowDefinition } from "@render-agents/sdk";
import { createTestRuntime } from "@render-agents/sdk/testing";
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

  it("reports configured providers and per-user connected status", async () => {
    const runtime = await createTestRuntime();
    const oauthProviders = new Map([["github", githubProvider]]);
    const app = createGatewayApp({ runtime, oauthProviders, disableAuth: true });

    // No userId → providers listed, none connected.
    const anon = await (await app.request("/connections")).json();
    expect(anon.providers).toEqual([{ provider: "github", connected: false, scopes: undefined, expiresAt: undefined }]);

    // Seed a connection for u1, then it reports connected with scopes.
    const now = new Date().toISOString();
    await runtime.oauthStore.upsertConnection({
      id: "u1:github", userId: "u1", provider: "github",
      accessToken: "tok", scopes: ["repo"], createdAt: now, updatedAt: now,
    });
    const mine = await (await app.request("/connections?userId=u1")).json();
    expect(mine.providers).toEqual([{ provider: "github", connected: true, scopes: ["repo"], expiresAt: undefined }]);

    // A different user still sees it as not connected.
    const other = await (await app.request("/connections?userId=u2")).json();
    expect(other.providers[0].connected).toBe(false);
  });
});
