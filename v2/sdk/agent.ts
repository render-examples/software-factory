/**
 * Render-native agent framework. ~100 lines total.
 *
 * Agent() — pure config describing an agent (prompt, tools, budget).
 * agentTask() — turns an Agent into a Render Workflows task using Claude Agent SDK.
 */
import { task } from "@renderinc/sdk/workflows";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { getThread, appendMessage } from "./threads.js";

// ---------------------------------------------------------------------------
// Agent — pure config, no behavior
// ---------------------------------------------------------------------------

export interface AgentSpec {
  readonly id: string;
  readonly description?: string;
  readonly prompt: string;
  readonly tools?: readonly string[];
  readonly budget?: { maxIterations?: number };
  readonly plan?: string;
  readonly interactive?: boolean;
}

export interface AgentDef {
  readonly __kind: "AgentDef";
  readonly id: string;
  readonly spec: AgentSpec;
}

export function Agent(spec: AgentSpec): AgentDef {
  if (!spec.id) throw new Error("Agent: id is required");
  if (!spec.prompt) throw new Error(`Agent "${spec.id}": prompt is required`);
  return Object.freeze({ __kind: "AgentDef" as const, id: spec.id, spec });
}

// ---------------------------------------------------------------------------
// md — inline Markdown prompt helper
// ---------------------------------------------------------------------------

export function md(strings: TemplateStringsArray, ...values: unknown[]): string {
  let raw = String.raw(strings, ...values);
  const lines = raw.split("\n");
  while (lines.length > 0 && lines[0].trim() === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  const indents = lines
    .filter((l) => l.trim().length > 0)
    .map((l) => l.match(/^(\s*)/)?.[1].length ?? 0);
  const minIndent = indents.length > 0 ? Math.min(...indents) : 0;
  if (minIndent > 0) return lines.map((l) => l.slice(minIndent)).join("\n");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// agentTask — bridge Agent config to a Render task via Claude Agent SDK
// ---------------------------------------------------------------------------

export interface AgentTaskInput {
  message: string;
  threadId?: string;
}

export function agentTask(agent: AgentDef) {
  return task(
    { name: agent.id, plan: agent.spec.plan },
    async function run(input: AgentTaskInput): Promise<string> {
      const history: string[] = [];

      if (agent.spec.interactive && input.threadId) {
        const thread = await getThread(input.threadId);
        if (thread) {
          for (const msg of thread.messages.slice(-20)) {
            history.push(`${msg.role}: ${msg.content}`);
          }
        }
      }

      const contextPrefix = history.length > 0
        ? `Previous conversation:\n${history.join("\n")}\n\nNew message: `
        : "";

      let result = "";
      for await (const msg of query({
        prompt: `${contextPrefix}${input.message}`,
        options: {
          systemPrompt: agent.spec.prompt,
          allowedTools: agent.spec.tools ? [...agent.spec.tools] : undefined,
          maxTurns: agent.spec.budget?.maxIterations,
        },
      })) {
        if (msg.type === "result") {
          result = typeof msg.result === "string" ? msg.result : JSON.stringify(msg.result);
        }
      }

      if (agent.spec.interactive && input.threadId) {
        await appendMessage(input.threadId, "assistant", result);
      }

      return result;
    },
  );
}
