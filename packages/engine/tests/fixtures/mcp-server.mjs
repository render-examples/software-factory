// Minimal stdio MCP server for end-to-end tests. Speaks newline-delimited
// JSON-RPC (initialize / tools/list / tools/call) — the same wire protocol the
// real `connectMcp` stdio client drives. Deliberately dependency-free so the
// test spawns it with plain `node <path>` and stays hermetic.

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    handle(msg);
  }
});

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

const TOOLS = [
  {
    name: "add",
    description: "Add two numbers and return the sum.",
    inputSchema: {
      type: "object",
      properties: { a: { type: "number" }, b: { type: "number" } },
      required: ["a", "b"],
    },
  },
  {
    name: "always_fails",
    description: "Always returns an error result (for the error path).",
    inputSchema: { type: "object" },
  },
];

function handle(msg) {
  const { id, method, params } = msg;

  // Notifications carry no id and expect no reply.
  if (id === undefined) return;

  switch (method) {
    case "initialize":
      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "test-mcp-server", version: "0.0.0" },
        },
      });
      return;

    case "tools/list":
      send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
      return;

    case "tools/call": {
      const name = params?.name;
      const args = params?.arguments ?? {};
      if (name === "add") {
        const sum = Number(args.a) + Number(args.b);
        send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: String(sum) }], isError: false } });
        return;
      }
      if (name === "always_fails") {
        send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "intentional failure" }], isError: true } });
        return;
      }
      send({ jsonrpc: "2.0", id, error: { code: -32602, message: `unknown tool: ${name}` } });
      return;
    }

    default:
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
  }
}
