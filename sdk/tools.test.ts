import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  ToolRegistry,
  createRegistry,
  isBuiltIn,
  isCustomTool,
} from "./tools.js";
import type { Tool, ToolSource, ToolResult, ToolContext, ResolvedTool } from "./tools.js";
import { ClaudeBuiltInToolSource } from "./runners/claude.js";

const echoSchema = { text: z.string() };

const echoTool: Tool<typeof echoSchema> = {
  name: "Echo",
  description: "Echoes back the input",
  inputSchema: echoSchema,
  async invoke(input, _ctx: ToolContext): Promise<ToolResult> {
    return { content: input.text };
  },
};

class EchoToolSource implements ToolSource {
  readonly id = "echo";
  resolve() {
    return [echoTool];
  }
}

function partition(tools: ResolvedTool[]) {
  const builtIn = tools.filter(isBuiltIn).map((t) => t.name);
  const custom = tools.filter(isCustomTool);
  return { builtIn, custom };
}

describe("ClaudeBuiltInToolSource", () => {
  it("resolves all Claude SDK built-in tools", () => {
    const source = new ClaudeBuiltInToolSource();
    const tools = source.resolve();
    const names = tools.map((t) => t.name);
    expect(names).toContain("Read");
    expect(names).toContain("Edit");
    expect(names).toContain("Bash");
    expect(names).toContain("Grep");
    expect(names).toContain("Glob");
    for (const t of tools) {
      expect(isBuiltIn(t)).toBe(true);
      expect(isCustomTool(t)).toBe(false);
    }
  });
});

describe("ToolRegistry", () => {
  it("resolves built-in tools from a registered source", async () => {
    const registry = createRegistry().register(new ClaudeBuiltInToolSource());
    const tools = await registry.resolve(["Read", "Bash"]);
    const { builtIn, custom } = partition(tools);
    expect(builtIn).toEqual(["Read", "Bash"]);
    expect(custom).toEqual([]);
  });

  it("resolves custom tools separately from built-in tools", async () => {
    const registry = createRegistry()
      .register(new ClaudeBuiltInToolSource())
      .register(new EchoToolSource());
    const tools = await registry.resolve(["Read", "Echo", "Bash"]);
    const { builtIn, custom } = partition(tools);
    expect(builtIn).toEqual(["Read", "Bash"]);
    expect(custom).toHaveLength(1);
    expect(custom[0].name).toBe("Echo");
  });

  it("throws for unknown tool names", async () => {
    const registry = createRegistry().register(new ClaudeBuiltInToolSource());
    await expect(registry.resolve(["Read", "NoSuchTool"])).rejects.toThrow(
      /NoSuchTool.*not found/,
    );
  });

  it("prevents duplicate source registration", () => {
    const registry = createRegistry().register(new ClaudeBuiltInToolSource());
    expect(() => registry.register(new ClaudeBuiltInToolSource())).toThrow(
      /already registered/,
    );
  });

  it("supports unregister", async () => {
    const registry = createRegistry().register(new EchoToolSource());
    expect(registry.has("echo")).toBe(true);
    registry.unregister("echo");
    expect(registry.has("echo")).toBe(false);
    await expect(registry.resolve(["Echo"])).rejects.toThrow(/not found/);
  });

  it("resolves empty tool list", async () => {
    const registry = createRegistry();
    const tools = await registry.resolve([]);
    expect(tools).toEqual([]);
  });
});

describe("Custom tool invocation", () => {
  it("invokes a custom tool and returns content", async () => {
    const result = await echoTool.invoke(
      { text: "hello world" },
      { agentId: "test" },
    );
    expect(result.content).toBe("hello world");
    expect(result.isError).toBeUndefined();
  });

  it("receives typed input from Zod schema", async () => {
    const mathSchema = {
      a: z.number(),
      b: z.number(),
      op: z.enum(["add", "sub", "mul"]),
    };

    const ops: Record<string, (a: number, b: number) => number> = {
      add: (a, b) => a + b,
      sub: (a, b) => a - b,
      mul: (a, b) => a * b,
    };

    const mathTool: Tool<typeof mathSchema> = {
      name: "Math",
      description: "Basic arithmetic",
      inputSchema: mathSchema,
      async invoke(input) {
        return { content: String(ops[input.op](input.a, input.b)) };
      },
    };

    const result = await mathTool.invoke(
      { a: 3, b: 4, op: "mul" },
      { agentId: "test" },
    );
    expect(result.content).toBe("12");
  });
});
