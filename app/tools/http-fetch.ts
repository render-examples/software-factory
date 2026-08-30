/**
 * HttpFetch — a custom tool that lets agents make HTTP requests.
 *
 * Proof-of-life for the pluggable tool system. The Claude Agent SDK has no
 * built-in HTTP tool, so this demonstrates custom tool registration,
 * resolution, and dispatch through the runner.
 */
import { z } from "zod";
import type { Tool, ToolSource, ToolResult, ToolContext, InferShape } from "../../sdk/tools.js";

const MAX_BODY = 50_000;

const inputSchema = {
  url: z.string().describe("The URL to fetch"),
  method: z
    .enum(["GET", "POST", "PUT", "PATCH", "DELETE"])
    .optional()
    .describe("HTTP method (defaults to GET)"),
  headers: z
    .record(z.string(), z.string())
    .optional()
    .describe("Optional headers as key-value pairs"),
  body: z
    .string()
    .optional()
    .describe("Optional request body (for POST/PUT/PATCH)"),
};

const httpFetchTool: Tool<typeof inputSchema> = {
  name: "HttpFetch",
  description:
    "Make an HTTP request and return the response body. " +
    "Supports GET, POST, PUT, PATCH, DELETE. " +
    "Use for fetching API data, checking endpoints, or downloading content.",
  inputSchema,

  async invoke(
    input: InferShape<typeof inputSchema>,
    _ctx: ToolContext,
  ): Promise<ToolResult> {
    const method = (input.method ?? "GET").toUpperCase();

    try {
      const resp = await fetch(input.url, {
        method,
        headers: input.headers,
        body: method !== "GET" && method !== "DELETE" ? input.body : undefined,
      });

      const text = await resp.text();
      const truncated =
        text.length > MAX_BODY
          ? text.slice(0, MAX_BODY) + "\n… [truncated]"
          : text;

      return {
        content: `HTTP ${resp.status} ${resp.statusText}\n\n${truncated}`,
        isError: resp.status >= 400,
      };
    } catch (err) {
      return {
        content: `Fetch failed: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
};

export class HttpFetchToolSource implements ToolSource {
  readonly id = "http-fetch";

  resolve() {
    return [httpFetchTool];
  }
}
