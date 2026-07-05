import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { DefineMcpSpec } from "./tool.js";
import { assertUrlAllowed } from "./ssrf-fetch.js";

const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "render-agents", version: "0" };
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_HTTP_RESPONSE_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * Environment variables passed to a spawned stdio MCP child. The child never
 * inherits the full parent environment (API keys, `DATABASE_URL`, the encryption
 * key, …) — only what a subprocess needs to launch, plus the server's own
 * explicitly-declared vars (CR-02).
 */
const ENV_PASSTHROUGH = [
  "PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "TEMP", "TMP",
  "PATHEXT", "SystemRoot", "USERPROFILE", "APPDATA",
];

function childEnv(declared?: Record<string, string>): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {};
  for (const key of ENV_PASSTHROUGH) {
    const value = process.env[key];
    if (value !== undefined) base[key] = value;
  }
  return { ...base, ...declared };
}

/** Read a response body with a hard byte cap so a hostile/broken MCP server
 *  can't exhaust memory (mirrors the ssrfFetch stream cap). */
async function readBodyCapped(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`MCP HTTP response exceeded ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpToolCallResult {
  content: string;
  isError: boolean;
}

/** A connected MCP session that can list and call tools. */
export interface McpConnection {
  listTools(): Promise<McpToolDescriptor[]>;
  callTool(name: string, args: unknown): Promise<McpToolCallResult>;
  close(): Promise<void>;
}

/** Connect to an MCP server over the transport declared in the spec. */
export async function connectMcp(spec: DefineMcpSpec): Promise<McpConnection> {
  if (spec.transport === "stdio") {
    if (!spec.command) throw new Error(`MCP source "${spec.name ?? "mcp"}" (stdio) requires a "command"`);
    return StdioMcpConnection.connect(spec.command, spec.args ?? [], spec.env);
  }
  if (spec.transport === "http") {
    if (!spec.url) throw new Error(`MCP source "${spec.name ?? "mcp"}" (http) requires a "url"`);
    return HttpMcpConnection.connect(spec.url, spec.headers);
  }
  throw new Error(`MCP source "${spec.name ?? "mcp"}": unsupported transport "${String(spec.transport)}"`);
}

/** Normalize an MCP `tools/call` result's content array into a single string. */
function flattenMcpContent(result: unknown): McpToolCallResult {
  const obj = (result ?? {}) as { content?: unknown; isError?: boolean };
  const isError = obj.isError === true;
  const blocks = Array.isArray(obj.content) ? obj.content : [];
  const text = blocks
    .map((b) => {
      const block = b as { type?: string; text?: string };
      if (block.type === "text" && typeof block.text === "string") return block.text;
      return JSON.stringify(block);
    })
    .join("\n");
  return { content: text || (isError ? "MCP tool error" : ""), isError };
}

// --- stdio transport (newline-delimited JSON-RPC) ---

class StdioMcpConnection implements McpConnection {
  private nextId = 1;
  private buffer = "";
  private readonly pending = new Map<number, { resolve: (r: JsonRpcResponse) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  private constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onData(chunk));
    // Drain stderr so chatty MCP servers cannot block on a full pipe.
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", () => {});
    child.on("error", (err) => this.failAll(err));
    child.on("exit", (code) => this.failAll(new Error(`MCP stdio server exited (code ${code})`)));
  }

  static async connect(command: string, args: string[], env?: Record<string, string>): Promise<StdioMcpConnection> {
    const child = spawn(command, args, {
      env: childEnv(env),
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    const conn = new StdioMcpConnection(child);
    await conn.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    });
    conn.notify("notifications/initialized");
    return conn;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: JsonRpcResponse;
      try {
        msg = JSON.parse(line) as JsonRpcResponse;
      } catch {
        continue;
      }
      const entry = typeof msg.id === "number" ? this.pending.get(msg.id) : undefined;
      if (entry) {
        clearTimeout(entry.timer);
        this.pending.delete(msg.id);
        entry.resolve(msg);
      }
    }
  }

  private failAll(err: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }

  private notify(method: string, params?: unknown): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  private request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    const req: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request "${method}" timed out after ${REQUEST_TIMEOUT_MS}ms`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (msg) => (msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)),
        reject,
        timer,
      });
      this.child.stdin.write(`${JSON.stringify(req)}\n`);
    });
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    const result = (await this.request("tools/list", {})) as { tools?: McpToolDescriptor[] };
    return result.tools ?? [];
  }

  async callTool(name: string, args: unknown): Promise<McpToolCallResult> {
    const result = await this.request("tools/call", { name, arguments: args ?? {} });
    return flattenMcpContent(result);
  }

  async close(): Promise<void> {
    this.failAll(new Error("MCP connection closed"));
    this.child.kill();
  }
}

// --- HTTP transport (Streamable HTTP JSON-RPC) ---

class HttpMcpConnection implements McpConnection {
  private nextId = 1;

  private constructor(
    private readonly url: string,
    private readonly headersFn?: () => Record<string, string>,
    private sessionId?: string,
  ) {}

  static async connect(url: string, headersFn?: () => Record<string, string>): Promise<HttpMcpConnection> {
    const conn = new HttpMcpConnection(url, headersFn);
    await conn.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    });
    await conn.request("notifications/initialized", undefined, true).catch(() => {});
    return conn;
  }

  private async request(method: string, params?: unknown, isNotification = false): Promise<unknown> {
    const body = isNotification
      ? { jsonrpc: "2.0", method, params }
      : { jsonrpc: "2.0", id: this.nextId++, method, params };

    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(this.headersFn?.() ?? {}),
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;

    // MCP endpoints are operator-configured (trusted) and are frequently local
    // or on the docker/private network — so loopback + private LAN are allowed,
    // but cloud-metadata/link-local targets are still blocked (CR-02). Validated
    // per-request (no connection-level IP pinning, to preserve TLS SNI).
    await assertUrlAllowed(this.url, { allowPrivateHosts: true });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(this.url, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }

    const session = res.headers.get("mcp-session-id");
    if (session) this.sessionId = session;
    if (isNotification) return undefined;
    if (!res.ok) throw new Error(`MCP HTTP request "${method}" failed: ${res.status} ${res.statusText}`);

    const parsed = await parseHttpJsonRpc(res);
    if (parsed.error) throw new Error(parsed.error.message);
    return parsed.result;
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    const result = (await this.request("tools/list", {})) as { tools?: McpToolDescriptor[] };
    return result.tools ?? [];
  }

  async callTool(name: string, args: unknown): Promise<McpToolCallResult> {
    const result = await this.request("tools/call", { name, arguments: args ?? {} });
    return flattenMcpContent(result);
  }

  async close(): Promise<void> {
    // Stateless HTTP: best-effort session teardown.
    if (!this.sessionId) return;
    try {
      await assertUrlAllowed(this.url, { allowPrivateHosts: true });
      await fetch(this.url, {
        method: "DELETE",
        headers: { "mcp-session-id": this.sessionId, ...(this.headersFn?.() ?? {}) },
      });
    } catch {
      // best-effort
    }
  }
}

/** Parse an MCP HTTP response as either a JSON body or an SSE stream. */
async function parseHttpJsonRpc(res: Response): Promise<JsonRpcResponse> {
  const contentType = res.headers.get("content-type") ?? "";
  const text = await readBodyCapped(res, MAX_HTTP_RESPONSE_BYTES);
  if (contentType.includes("text/event-stream")) {
    // Take the last `data:` payload that parses as a JSON-RPC response.
    const dataLines = text
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim());
    for (let i = dataLines.length - 1; i >= 0; i--) {
      try {
        return JSON.parse(dataLines[i]) as JsonRpcResponse;
      } catch {
        // try the next one
      }
    }
    throw new Error("MCP HTTP (SSE) response contained no parseable JSON-RPC message");
  }
  return JSON.parse(text) as JsonRpcResponse;
}
