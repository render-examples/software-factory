/**
 * ClaudeRunner — AgentRunner backed by the Claude Agent SDK.
 * Built-in tools pass through to the SDK; custom tools are bridged via MCP.
 */
import {
  query,
  createSdkMcpServer,
  tool as sdkTool,
} from "@anthropic-ai/claude-agent-sdk";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { AgentRunner, AgentEvent, RunContext } from "../runner.js";
import {
  isBuiltIn,
  isCustomTool,
  type Tool,
  type ToolContext,
  type BuiltInTool,
  type ToolSource,
} from "../tools.js";

const CLAUDE_BUILTIN_NAMES = new Set([
  "Read",
  "Edit",
  "Write",
  "Bash",
  "Grep",
  "Glob",
  "NotebookEdit",
]);

export class ClaudeBuiltInToolSource implements ToolSource {
  readonly id = "claude-built-in";

  resolve(): BuiltInTool[] {
    return [...CLAUDE_BUILTIN_NAMES].map((name) => ({
      name,
      builtIn: true as const,
    }));
  }
}

const MCP_SERVER_NAME = "factory-tools";

export class ClaudeRunner implements AgentRunner {
  async *run(ctx: RunContext): AsyncIterable<AgentEvent> {
    const builtInNames: string[] = [];
    const customTools: Tool[] = [];

    for (const tool of ctx.tools) {
      if (isBuiltIn(tool) && CLAUDE_BUILTIN_NAMES.has(tool.name)) {
        builtInNames.push(tool.name);
      } else if (isCustomTool(tool)) {
        customTools.push(tool);
      }
    }

    const abortController = ctx.signal
      ? abortControllerFromSignal(ctx.signal)
      : undefined;

    // MCP tools are namespaced as mcp__<server>__<tool> by the SDK
    const mcpToolNames = customTools.map(
      (t) => `mcp__${MCP_SERVER_NAME}__${t.name}`,
    );
    const allAllowed = [...builtInNames, ...mcpToolNames];

    const options: Options = {
      systemPrompt: ctx.systemPrompt,
      allowedTools: allAllowed.length > 0 ? allAllowed : undefined,
      maxTurns: ctx.maxTurns,
    };

    if (abortController) {
      options.abortController = abortController;
    }

    if (customTools.length > 0) {
      const toolDefs = customTools.map((t) =>
        bridgeToolToSdk(t, ctx.agentId, ctx.signal),
      );
      options.mcpServers = {
        [MCP_SERVER_NAME]: createSdkMcpServer({
          name: MCP_SERVER_NAME,
          tools: toolDefs,
          alwaysLoad: true,
        }),
      };
    }

    try {
      for await (const msg of query({ prompt: ctx.prompt, options })) {
        const event = mapSdkMessage(msg);
        if (event) yield event;
      }
    } catch (err) {
      yield {
        type: "error",
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }
  }
}

function bridgeToolToSdk(tool: Tool, agentId: string, signal?: AbortSignal) {
  const toolCtx: ToolContext = { agentId, signal };

  return sdkTool(
    tool.name,
    tool.description,
    tool.inputSchema,
    async (args) => {
      const result = await tool.invoke(args, toolCtx);
      return {
        content: [{ type: "text" as const, text: result.content }],
        isError: result.isError ?? false,
      };
    },
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapSdkMessage(msg: any): AgentEvent | null {
  switch (msg.type) {
    case "result":
      return {
        type: "result",
        result:
          typeof msg.result === "string"
            ? msg.result
            : JSON.stringify(msg.result),
      };
    case "assistant":
      if (typeof msg.message?.content === "string") {
        return { type: "text", text: msg.message.content };
      }
      if (Array.isArray(msg.message?.content)) {
        for (const block of msg.message.content) {
          if (block.type === "text") {
            return { type: "text", text: block.text };
          }
        }
      }
      return null;
    default:
      return null;
  }
}

function abortControllerFromSignal(signal: AbortSignal): AbortController {
  const controller = new AbortController();
  if (signal.aborted) {
    controller.abort(signal.reason);
  } else {
    signal.addEventListener("abort", () => controller.abort(signal.reason), {
      once: true,
    });
  }
  return controller;
}
