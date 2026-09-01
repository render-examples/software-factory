import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  isBuiltIn,
  isCustomTool,
} from "../tools.js";
import type { Tool, ToolResult, ToolContext, ResolvedTool } from "../tools.js";
import {
  sandboxExec,
  sandboxReadFile,
  sandboxWriteFile,
  sandboxListDir,
  sandboxApplyPatch,
  sandboxSearch,
  allSandboxTools,
  createSandboxToolsForProvider,
} from "../sandbox-tool-source.js";
import type { SandboxProvider, Sandbox } from "../sandbox/index.js";

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

describe("Module-level sandbox tools", () => {
  it("exports 6 named sandbox tools", () => {
    const tools = [
      sandboxExec,
      sandboxReadFile,
      sandboxWriteFile,
      sandboxListDir,
      sandboxApplyPatch,
      sandboxSearch,
    ];
    expect(tools).toHaveLength(6);
    const names = tools.map((t) => t.name);
    expect(names).toContain("sandbox__exec");
    expect(names).toContain("sandbox__read_file");
    expect(names).toContain("sandbox__write_file");
    expect(names).toContain("sandbox__list_dir");
    expect(names).toContain("sandbox__apply_patch");
    expect(names).toContain("sandbox__search");

    for (const tool of tools) {
      expect(isCustomTool(tool)).toBe(true);
      expect(isBuiltIn(tool)).toBe(false);
    }
  });

  it("provides allSandboxTools convenience array", () => {
    expect(allSandboxTools).toHaveLength(6);
    expect(allSandboxTools.map((t) => t.name)).toEqual([
      "sandbox__exec",
      "sandbox__read_file",
      "sandbox__write_file",
      "sandbox__list_dir",
      "sandbox__apply_patch",
      "sandbox__search",
    ]);
  });
});

describe("createSandboxToolsForProvider", () => {
  const stubProvider: SandboxProvider = {
    name: "stub",
    async create() {
      return {} as Sandbox;
    },
    async connect() {
      return {} as Sandbox;
    },
  };

  it("creates an isolated set of 6 sandbox tools", () => {
    const tools = createSandboxToolsForProvider(stubProvider);
    expect(tools.all()).toHaveLength(6);
    expect(tools.exec.name).toBe("sandbox__exec");
    expect(tools.readFile.name).toBe("sandbox__read_file");
  });

  it("binds sandbox access through trusted tool context", async () => {
    const readFile = async () => "contents";
    const connect = async (sandboxId: string) => {
      expect(sandboxId).toBe("sandbox-owned-by-workflow");
      return { readFile } as unknown as Sandbox;
    };
    const tools = createSandboxToolsForProvider({
      name: "bound",
      create: stubProvider.create,
      connect,
    });

    expect(tools.readFile.inputSchema).not.toHaveProperty("sandbox_id");
    const result = await tools.readFile.invoke(
      { path: "/workspace/file.txt" },
      { agentId: "analyst", sandboxId: "sandbox-owned-by-workflow" },
    );
    expect(result.content).toBe("contents");
    await expect(
      tools.readFile.invoke(
        { path: "/workspace/file.txt" },
        { agentId: "analyst" },
      ),
    ).rejects.toThrow(/no sandbox binding/);
  });
});
