import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { createMemoryStore, type Tracer } from "@render-agents/store";
import { defineMcpSource, ToolEnvironment } from "../src/tool-impl.js";
import { InProcessRunContext } from "../src/run-context.js";
import { passThroughContextManager } from "../src/context-manager.js";
import { DefaultRunner } from "../src/default-runner.js";
import type { AgentDefinition } from "../src/agent.js";
import type { ModelClient, CompleteResult } from "../src/model.js";
import type { ToolSource, ToolContext } from "../src/tool.js";

const noopTracer: Tracer = { onStart: () => {}, onEnd: () => {} };
const silentLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

// The real stdio JSON-RPC MCP server, spawned as `node <fixture>` so the whole
// transport (spawn → initialize handshake → tools/list → tools/call → close) is
// exercised for real, hermetically, with no network or external dependency.
const serverPath = fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url));

function calcMcpSource(): ToolSource {
  return defineMcpSource({
    name: "calc",
    transport: "stdio",
    command: process.execPath, // absolute path to the running node binary
    args: [serverPath],
  });
}

function mockModel(responses: CompleteResult[]): ModelClient {
  let i = 0;
  return {
    async complete(): Promise<CompleteResult> {
      const r = responses[Math.min(i, responses.length - 1)];
      i += 1;
      return r;
    },
  };
}

describe("MCP end-to-end (real stdio server)", () => {
  it("connects, lists, and invokes a real MCP tool through ToolEnvironment", async () => {
    const env = new ToolEnvironment();
    try {
      const mounted = await env.mount(
        new Map([["calc", calcMcpSource()]]),
        ["calc"],
        silentLogger,
        new AbortController().signal,
      );

      // Server tools are namespaced by the directory key the agent referenced.
      expect(mounted.tools.map((t) => t.name).sort()).toEqual(["calc__add", "calc__always_fails"]);

      const add = mounted.byName("calc__add");
      expect(add).toBeDefined();
      const result = await add!.invoke({ a: 2, b: 3 }, undefined as unknown as ToolContext);
      expect(result).toMatchObject({ content: "5", isError: false });
    } finally {
      await env.dispose(); // closes the connection + kills the child process
    }
  });

  it("surfaces an MCP isError result without throwing", async () => {
    const env = new ToolEnvironment();
    try {
      const mounted = await env.mount(
        new Map([["calc", calcMcpSource()]]),
        ["calc"],
        silentLogger,
        new AbortController().signal,
      );
      const fail = mounted.byName("calc__always_fails");
      const result = await fail!.invoke({}, undefined as unknown as ToolContext);
      expect(result.isError).toBe(true);
      expect(result.content).toContain("intentional failure");
    } finally {
      await env.dispose();
    }
  });

  it("drives an MCP tool through the full agent loop (DefaultRunner)", async () => {
    const store = createMemoryStore();
    const agent: AgentDefinition = {
      name: "tester",
      model: { provider: "anthropic", model: "claude-haiku-4-5" },
      systemPrompt: "do math via tools",
      tools: ["calc"],
    };

    const ctx = new InProcessRunContext({
      runId: "r1",
      store,
      tracer: noopTracer,
      model: agent.model,
      agentName: agent.name,
      contextManager: passThroughContextManager,
      signal: new AbortController().signal,
      toolSources: new Map([["calc", calcMcpSource()]]),
    });

    // Turn 1: model asks for the MCP tool; Turn 2: model answers with the result.
    const responses: CompleteResult[] = [
      {
        content: [{ type: "tool_use", id: "tc1", name: "calc__add", input: { a: 2, b: 3 } }],
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "tool_use",
      },
      {
        content: [{ type: "text", text: "the sum is 5" }],
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "end_turn",
      },
    ];

    const out = await new DefaultRunner(mockModel(responses)).run(agent, "add 2 and 3", ctx);
    expect(out.text).toBe("the sum is 5");

    // The tool_result folded into the transcript carries the real MCP output.
    const toolMsg = (await store.getMessages("r1", "tester")).find((m) => m.role === "tool");
    expect(toolMsg?.content[0]).toMatchObject({ type: "tool_result", content: "5", isError: false });

    const types = (await store.events.read("r1")).map((e) => e.type);
    expect(types).toContain("tool.called");
    expect(types).toContain("tool.result");
    expect(types[types.length - 1]).toBe("run.completed");
  });
});
