import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  isBuiltIn,
  isCustomTool,
} from "../tools.js";
import type { Tool, ToolResult, ToolContext, ResolvedTool } from "../tools.js";

const echoSchema = { text: z.string() };

const echoTool: Tool<typeof echoSchema> = {
  name: "Echo",
  description: "Echoes back the input",
  inputSchema: echoSchema,
  async invoke(input, _ctx: ToolContext): Promise<ToolResult> {
    return { content: input.text };
  },
};

function partition(tools: ResolvedTool[]) {
  const builtIn = tools.filter(isBuiltIn).map((t) => t.name);
  const custom = tools.filter(isCustomTool);
  return { builtIn, custom };
}

describe("Tool type guards", () => {
  it("identifies built-in tools", () => {
    const builtIn = { name: "Read", builtIn: true as const };
    expect(isBuiltIn(builtIn)).toBe(true);
    expect(isCustomTool(builtIn)).toBe(false);
  });

  it("identifies custom tools", () => {
    expect(isCustomTool(echoTool)).toBe(true);
    expect(isBuiltIn(echoTool)).toBe(false);
  });

  it("partitions mixed tool arrays", () => {
    const mixed: ResolvedTool[] = [
      { name: "Read", builtIn: true as const },
      echoTool,
      { name: "Bash", builtIn: true as const },
    ];
    const { builtIn, custom } = partition(mixed);
    expect(builtIn).toEqual(["Read", "Bash"]);
    expect(custom).toHaveLength(1);
    expect(custom[0].name).toBe("Echo");
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
