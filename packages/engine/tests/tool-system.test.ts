import { describe, it, expect, vi } from "vitest";
import { validateToolInput } from "../src/schema-validate.js";
import { ssrfFetch } from "../src/ssrf-fetch.js";
import { defineTool, defineToolSource, ToolEnvironment } from "../src/tool-impl.js";
import type { Logger } from "@render-factory/store";

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

describe("validateToolInput", () => {
  const schema = {
    type: "object",
    properties: {
      q: { type: "string" },
    },
    required: ["q"],
  };

  it("returns undefined on valid input", () => {
    expect(validateToolInput({ q: "hello" }, schema)).toBeUndefined();
  });

  it("returns a validation error string on invalid input", () => {
    const err = validateToolInput({}, schema);
    expect(err).toContain("Input validation failed");
    expect(err).toContain("q");
  });

  it("returns undefined for empty schema (pass-through)", () => {
    expect(validateToolInput({ anything: true }, {})).toBeUndefined();
  });
});

describe("defineTool (single-tool source)", () => {
  it("creates a ToolSource with a single tool that resolves", async () => {
    const source = defineTool({
      name: "echo",
      description: "echoes input",
      inputSchema: { type: "object" },
      invoke: async (input) => `echoed: ${JSON.stringify(input)}`,
    });
    expect(source.id).toBe("echo");
    const resolved = await source.resolve(undefined as never);
    expect(resolved.tools).toHaveLength(1);
    expect(resolved.tools[0].name).toBe("echo");
    const result = await resolved.tools[0].invoke({ msg: "hi" }, undefined as never);
    expect(result.content).toBe('echoed: {"msg":"hi"}');
  });
});

describe("defineToolSource (multi-tool source)", () => {
  it("creates a source with multiple tools namespaced sourceId__toolName", async () => {
    const source = defineToolSource("github", [
      { name: "get_file", description: "gets a file", inputSchema: {}, invoke: async () => "file content" },
      { name: "create_pr", description: "creates a PR", inputSchema: {}, invoke: async () => "pr created" },
    ]);
    expect(source.id).toBe("github");
    const resolved = await source.resolve(undefined as never);
    expect(resolved.tools).toHaveLength(2);
    expect(resolved.tools.map((t) => t.name).sort()).toEqual(["github__create_pr", "github__get_file"]);
  });
});

describe("ToolEnvironment", () => {
  it("mounts declared tools and produces a MountedTools map", async () => {
    const source = defineTool({
      name: "search",
      description: "search",
      inputSchema: {},
      invoke: async () => "found",
    });
    const sourceMap = new Map([["search", source]]);
    const env = new ToolEnvironment();
    const mounted = await env.mount(sourceMap, ["search"], silentLogger, new AbortController().signal);
    expect(mounted.tools).toHaveLength(1);
    expect(mounted.byName("search")?.name).toBe("search");
    await env.dispose();
  });

  it("multi-tool source mounts with namespaced names", async () => {
    const source = defineToolSource("github", [
      { name: "get_file", description: "x", inputSchema: {}, invoke: async () => "ok" },
      { name: "push_code", description: "x", inputSchema: {}, invoke: async () => "ok" },
    ]);
    const sourceMap = new Map([["github", source]]);
    const env = new ToolEnvironment();
    const mounted = await env.mount(sourceMap, ["github"], silentLogger, new AbortController().signal);
    expect(mounted.tools.map((t) => t.name).sort()).toEqual(["github__get_file", "github__push_code"]);
    expect(mounted.byName("github__push_code")).toBeDefined();
    await env.dispose();
  });

  it("mounts only a specific namespaced tool when declared", async () => {
    const source = defineToolSource("github", [
      { name: "get_file", description: "x", inputSchema: {}, invoke: async () => "ok" },
      { name: "push_code", description: "x", inputSchema: {}, invoke: async () => "ok" },
    ]);
    const sourceMap = new Map([["github", source]]);
    const env = new ToolEnvironment();
    const mounted = await env.mount(sourceMap, ["github__get_file"], silentLogger, new AbortController().signal);
    expect(mounted.tools).toHaveLength(1);
    expect(mounted.tools[0].name).toBe("github__get_file");
    await env.dispose();
  });

  it("resolves each source only once per mount even with multiple declared tools", async () => {
    let resolveCalls = 0;
    const source = {
      id: "github",
      async resolve() {
        resolveCalls += 1;
        return {
          tools: [
            { name: "get_file", description: "x", inputSchema: {}, invoke: async () => ({ content: "ok" }) },
            { name: "push_code", description: "x", inputSchema: {}, invoke: async () => ({ content: "ok" }) },
          ],
          close: async () => {},
        };
      },
    };
    const env = new ToolEnvironment();
    const mounted = await env.mount(
      new Map([["github", source]]),
      ["github__get_file", "github__push_code"],
      silentLogger,
      new AbortController().signal,
    );
    expect(resolveCalls).toBe(1);
    expect(mounted.tools.map((t) => t.name).sort()).toEqual(["github__get_file", "github__push_code"]);
    await env.dispose();
  });

  it("namespaces prefixTools (MCP) sources by the directory key, incl. a single tool (BUG-10)", async () => {
    // Mirrors what defineMcpSource emits: bare server tool names + prefixTools.
    const mcpMulti = {
      id: "mcp", // server-chosen id, deliberately different from the dir key
      async resolve() {
        return {
          prefixTools: true,
          tools: [
            { name: "web_search", description: "x", inputSchema: {}, invoke: async () => ({ content: "ok" }) },
            { name: "news", description: "x", inputSchema: {}, invoke: async () => ({ content: "ok" }) },
          ],
          close: async () => {},
        };
      },
    };
    const mcpSingle = {
      id: "mcp",
      async resolve() {
        return {
          prefixTools: true,
          tools: [{ name: "run", description: "x", inputSchema: {}, invoke: async () => ({ content: "ok" }) }],
          close: async () => {},
        };
      },
    };
    const env = new ToolEnvironment();
    const mounted = await env.mount(
      new Map([["brave", mcpMulti], ["linear", mcpSingle]]),
      ["brave", "linear"],
      silentLogger,
      new AbortController().signal,
    );
    // Directory key is the namespace, not the server's "mcp" id; single tool is
    // still `linear__run`, not the bare `linear`.
    expect(mounted.tools.map((t) => t.name).sort()).toEqual(["brave__news", "brave__web_search", "linear__run"]);
    await env.dispose();
  });

  it("throws on model-facing name collision", async () => {
    const s1 = defineTool({ name: "search", description: "x", inputSchema: {}, invoke: async () => "a" });
    const s2 = defineTool({ name: "search2", description: "x", inputSchema: {}, invoke: async () => "b" });
    // s2 resolve also gives a tool named "search2" but s1 is "search" — simulate collision by mounting same id twice
    const sourceMap = new Map([["search", s1]]);
    const env = new ToolEnvironment();
    await expect(
      env.mount(sourceMap, ["search", "search"], silentLogger, new AbortController().signal),
    ).rejects.toThrow(/collision/);
    await env.dispose();
  });

  it("throws on reserved name load_skill", async () => {
    const source = defineTool({
      name: "load_skill",
      description: "x",
      inputSchema: {},
      invoke: async () => "x",
    });
    const sourceMap = new Map([["load_skill", source]]);
    const env = new ToolEnvironment();
    await expect(
      env.mount(sourceMap, ["load_skill"], silentLogger, new AbortController().signal),
    ).rejects.toThrow(/reserved/);
    await env.dispose();
  });
});

describe("ssrfFetch", () => {
  it("blocks metadata endpoint 169.254.169.254", async () => {
    await expect(ssrfFetch("http://169.254.169.254/latest/")).rejects.toThrow(/SSRF blocked/);
  });

  it("blocks localhost", async () => {
    await expect(ssrfFetch("http://127.0.0.1:8080/secret")).rejects.toThrow(/SSRF blocked/);
  });

  it("blocks private IP 10.x", async () => {
    await expect(ssrfFetch("http://10.0.0.1/internal")).rejects.toThrow(/SSRF blocked/);
  });

  it("blocks private IP 192.168.x", async () => {
    await expect(ssrfFetch("http://192.168.1.1/admin")).rejects.toThrow(/SSRF blocked/);
  });

  it("allows a public literal IP and returns the response", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ok", { status: 200, headers: { "content-type": "text/plain" } }),
    );
    try {
      const res = await ssrfFetch("http://93.184.216.34/hello");
      expect(res.status).toBe(200);
      await expect(res.text()).resolves.toBe("ok");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      fetchMock.mockRestore();
    }
  });
});
