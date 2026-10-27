import { errorMessage } from "../core/emit.js";
import { createFactoryTools, type ToolOptions } from "./index.js";

/** MCP protocol revision answered when the client doesn't name one. */
const DEFAULT_PROTOCOL = "2025-06-18";

interface JsonRpcMessage {
	jsonrpc?: string;
	id?: string | number | null;
	method?: string;
	params?: Record<string, unknown>;
}

/**
 * Serves the factory tools named in `opts.tools` over MCP's stdio transport (one JSON-RPC message per line), so an
 * agent library without the factory's tools (Pydantic AI) gets the same implementations, environment, read-only
 * policy, and limits as every other harness. Implements initialize, tools/list, tools/call, and ping. Returns when
 * stdin closes.
 */
export async function serveMcpTools(
	opts: ToolOptions,
	io: { stdin: AsyncIterable<string | Uint8Array>; write(chunk: string): Promise<void> },
): Promise<number> {
	const tools = new Map(createFactoryTools(opts).map((tool) => [tool.name as string, tool]));
	let writes = Promise.resolve();
	const send = (message: object) => {
		writes = writes.then(() => io.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`)).catch(() => {});
	};
	const inflight = new Set<Promise<void>>();

	const handle = async (message: JsonRpcMessage) => {
		const { id, method, params = {} } = message;
		if (id === undefined || id === null) return; // a notification: nothing to answer
		switch (method) {
			case "initialize":
				return send({
					id,
					result: {
						protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : DEFAULT_PROTOCOL,
						capabilities: { tools: { listChanged: false } },
						serverInfo: { name: "software-factory-tools", version: "1.0.0" },
					},
				});
			case "ping":
				return send({ id, result: {} });
			case "tools/list":
				return send({
					id,
					result: { tools: [...tools.values()].map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters })) },
				});
			case "tools/call": {
				const tool = tools.get(String(params.name));
				if (!tool) return send({ id, result: { content: [{ type: "text", text: `Tool ${String(params.name)} not found` }], isError: true } });
				const out = await tool.execute(params.arguments ?? {});
				return send({ id, result: { content: [{ type: "text", text: out.text }], isError: out.isError } });
			}
			default:
				return send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
		}
	};

	let buffer = "";
	const dispatch = (line: string) => {
		if (!line.trim()) return;
		let message: JsonRpcMessage;
		try {
			message = JSON.parse(line) as JsonRpcMessage;
		} catch (err) {
			send({ id: null, error: { code: -32700, message: `Parse error: ${errorMessage(err)}` } });
			return;
		}
		const task = handle(message).catch((err: unknown) => {
			if (message.id !== undefined && message.id !== null) send({ id: message.id, error: { code: -32603, message: errorMessage(err) } });
		});
		inflight.add(task);
		void task.finally(() => inflight.delete(task));
	};
	for await (const chunk of io.stdin) {
		buffer += Buffer.from(chunk).toString("utf8");
		let newline = buffer.indexOf("\n");
		while (newline !== -1) {
			dispatch(buffer.slice(0, newline));
			buffer = buffer.slice(newline + 1);
			newline = buffer.indexOf("\n");
		}
	}
	dispatch(buffer);
	await Promise.all(inflight);
	await writes;
	return 0;
}
