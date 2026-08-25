import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createMemoryStore, type Tracer } from "@render-factory/store";
import { defineMcpSource, ToolEnvironment } from "../src/tool-impl.js";
import { InProcessRunContext } from "../src/run-context.js";
import { passThroughContextManager } from "../src/context-manager.js";
import { DefaultRunner } from "../src/default-runner.js";
import type { AgentDefinition } from "../src/agent.js";
import type { ModelClient, CompleteResult } from "../src/model.js";
import type { ToolSource, ToolContext } from "../src/tool.js";

const noopTracer: Tracer = { onStart: () => {}, onEnd: () => {} };
const silentLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/**
 * A minimal in-process Streamable-HTTP MCP server implementing the JSON-RPC the
 * real `HttpMcpConnection` client drives: `initialize` (with an mcp-session-id),
 * `tools/list`, `tools/call`, and DELETE teardown. `initialize`/`tools/list`
 * reply as `application/json`; `tools/call` replies as `text/event-stream` to
 * also exercise the SSE parse branch of `parseHttpJsonRpc`.
 */
function startMcpHttpServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    if (req.method === "DELETE") {
      res.writeHead(200).end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      let msg: { id?: number; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
      try {
        msg = JSON.parse(body);
      } catch {
        res.writeHead(400).end();
        return;
      }
      const { id, method, params } = msg;

      // Notifications carry no id and expect no JSON-RPC reply.
      if (id === undefined) {
        res.writeHead(202).end();
        return;
      }

      const json = (payload: unknown): void => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      const sse = (payload: unknown): void => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
      };

      if (method === "initialize") {
        res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "http-session-1" });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "http-mcp", version: "0" } },
        }));
        return;
      }
      if (method === "tools/list") {
        json({
          jsonrpc: "2.0",
          id,
          result: {
            tools: [{
              name: "echo",
              description: "Echo the message back.",
              inputSchema: { type: "object", properties: { msg: { type: "string" } }, required: ["msg"] },
            }],
          },
        });
        return;
      }
      if (method === "tools/call") {
        const name = params?.name;
        const args = params?.arguments ?? {};
        if (name === "echo") {
          // Reply over SSE to exercise the text/event-stream branch.
          sse({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `echo: ${String(args.msg)}` }], isError: false } });
          return;
        }
        json({ jsonrpc: "2.0", id, error: { code: -32602, message: `unknown tool: ${String(name)}` } });
        return;
      }
      json({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${String(method)}` } });
    });
  };

  return new Promise((resolve) => {
    const server: Server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/mcp`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
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

describe("MCP end-to-end (real HTTP server)", () => {
  let server: { url: string; close: () => Promise<void> };

  beforeAll(async () => { server = await startMcpHttpServer(); });
  afterAll(async () => { await server.close(); });

  function remoteMcpSource(): ToolSource {
    return defineMcpSource({ name: "remote", transport: "http", url: server.url });
  }

  it("connects over HTTP, lists, and invokes a tool (SSE response path)", async () => {
    const env = new ToolEnvironment();
    try {
      const mounted = await env.mount(
        new Map([["remote", remoteMcpSource()]]),
        ["remote"],
        silentLogger,
        new AbortController().signal,
      );
      expect(mounted.tools.map((t) => t.name)).toEqual(["remote__echo"]);
      const echo = mounted.byName("remote__echo");
      const result = await echo!.invoke({ msg: "hi" }, undefined as unknown as ToolContext);
      expect(result).toMatchObject({ content: "echo: hi", isError: false });
    } finally {
      await env.dispose();
    }
  });

  it("drives an HTTP MCP tool through the full agent loop (DefaultRunner)", async () => {
    const store = createMemoryStore();
    const agent: AgentDefinition = {
      name: "tester",
      model: { provider: "anthropic", model: "claude-haiku-4-5" },
      systemPrompt: "use tools",
      tools: ["remote"],
    };
    const ctx = new InProcessRunContext({
      runId: "r1",
      store,
      tracer: noopTracer,
      model: agent.model,
      agentName: agent.name,
      contextManager: passThroughContextManager,
      signal: new AbortController().signal,
      toolSources: new Map([["remote", remoteMcpSource()]]),
    });

    const responses: CompleteResult[] = [
      {
        content: [{ type: "tool_use", id: "tc1", name: "remote__echo", input: { msg: "pong" } }],
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "tool_use",
      },
      {
        content: [{ type: "text", text: "done" }],
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "end_turn",
      },
    ];

    const out = await new DefaultRunner(mockModel(responses)).run(agent, "echo pong", ctx);
    expect(out.text).toBe("done");

    const toolMsg = (await store.getMessages("r1", "tester")).find((m) => m.role === "tool");
    expect(toolMsg?.content[0]).toMatchObject({ type: "tool_result", content: "echo: pong", isError: false });
    const types = (await store.events.read("r1")).map((e) => e.type);
    expect(types).toContain("tool.result");
    expect(types[types.length - 1]).toBe("run.completed");
  });
});
