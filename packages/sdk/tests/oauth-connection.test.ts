import { describe, it, expect } from "vitest";
import type { AgentDefinition, OAuthRefresher } from "@render-agents/engine";
import type { OAuthConnection } from "@render-agents/store";
import { createTestRuntime, mockModel } from "../src/testing.js";
import { defineTool } from "../src/authoring.js";

function whoamiAgent(): AgentDefinition {
  return {
    name: "connector",
    model: { provider: "anthropic", model: "claude-haiku-4-5" },
    systemPrompt: "use the token",
    tools: ["whoami"],
  };
}

/** Model: call the whoami tool once, then echo its result as final text. */
function toolThenText() {
  const responses = [
    { content: [{ type: "tool_use" as const, id: "tc1", name: "whoami", input: {} }], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "tool_use" },
    { content: [{ type: "text" as const, text: "done" }], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" },
  ];
  let i = 0;
  return mockModel(() => responses[Math.min(i++, responses.length - 1)]);
}

describe("ToolContext.connection() — OAuth tokens reach tools in a run (M3)", () => {
  it("resolves the run user's stored token", async () => {
    let seenToken: string | undefined;
    const toolSources = new Map([
      ["whoami", defineTool({
        name: "whoami", description: "reads the github token", inputSchema: {},
        async invoke(_input, ctx) {
          const conn = await ctx.connection("github");
          seenToken = conn?.accessToken;
          return conn?.accessToken ?? "no-token";
        },
      })],
    ]);
    const runtime = await createTestRuntime({ model: toolThenText(), toolSources });
    runtime.agentDefinitions.set("connector", whoamiAgent());

    const now = new Date().toISOString();
    await runtime.oauthStore.upsertConnection({
      id: "u1:github", userId: "u1", provider: "github",
      accessToken: "ghp_live", scopes: ["repo"], createdAt: now, updatedAt: now,
    });

    // Dispatch with the user identity so connection() resolves their token.
    await runtime.dispatcher!.dispatch("connector", "go", { runId: "r-oauth-1", idempotencyKey: "r-oauth-1", userId: "u1" });
    expect(seenToken).toBe("ghp_live");
  });

  it("refreshes an expired token exactly once under concurrency (single-flight)", async () => {
    const runtime = await createTestRuntime({ model: toolThenText() });
    const past = new Date(Date.now() - 60_000).toISOString();
    await runtime.oauthStore.upsertConnection({
      id: "u2:github", userId: "u2", provider: "github",
      accessToken: "stale", refreshToken: "rt", expiresAt: past, scopes: [], createdAt: past, updatedAt: past,
    });

    let refreshCount = 0;
    const refresher: OAuthRefresher = async (_conn: OAuthConnection) => {
      refreshCount += 1;
      await new Promise((r) => setTimeout(r, 5));
      return { accessToken: "fresh", refreshToken: "rt2", expiresAt: new Date(Date.now() + 3600_000).toISOString() };
    };

    // Concurrent refreshes coalesce into a single provider exchange.
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        runtime.oauthStore.refreshConnection("u2", "github", (c) => {
          const exp = c.expiresAt ? Date.parse(c.expiresAt) : Infinity;
          return Date.now() >= exp - 60_000;
        }, refresher),
      ),
    );

    expect(refreshCount).toBe(1);
    expect(results.every((r) => r?.accessToken === "fresh")).toBe(true);
    expect((await runtime.oauthStore.getConnection("u2", "github"))?.accessToken).toBe("fresh");
  });
});
