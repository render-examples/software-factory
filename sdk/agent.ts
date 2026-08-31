/**
 * Agent() — config describing an agent (prompt, tools, budget).
 * agentTask() — turns an Agent into a Render Workflows task.
 */
import { randomUUID } from "node:crypto";
import { task } from "@renderinc/sdk/workflows";
import { maybePutBlob } from "./blobs.js";
import { createRegistry, type ToolRegistry } from "./tools.js";
import { ClaudeRunner } from "./runners/index.js";
import type { AgentRunner } from "./runner.js";
import { HookInterceptor, type Hook } from "./hooks.js";

export interface AgentSpec {
  readonly id: string;
  readonly description?: string;
  readonly prompt: string;
  readonly tools?: readonly string[];
  readonly budget?: { maxIterations?: number };
  readonly plan?: string;
  /** Model size tier ("small", "medium", "large") or a literal model string. */
  readonly model?: string;
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

/** Tagged template that strips leading indentation from inline prompts. */
export function md(strings: TemplateStringsArray, ...values: unknown[]): string {
  const raw = String.raw(strings, ...values);
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

export interface AgentTaskInput {
  message: string;
  /** Workflow-owned sandbox binding; never supplied by the model. */
  sandboxId?: string;
}

export interface AgentTaskOptions {
  runner?: AgentRunner;
  registry?: ToolRegistry;
  hooks?: Hook[];
}

let _defaultRunner: AgentRunner | undefined;
let _defaultRegistry: ToolRegistry | undefined;
let _defaultHooks: Hook[] = [];

function defaultRunner(): AgentRunner {
  _defaultRunner ??= new ClaudeRunner();
  return _defaultRunner;
}

function defaultRegistry(): ToolRegistry {
  _defaultRegistry ??= createRegistry();
  return _defaultRegistry;
}

/** Override the default runner, registry, and/or hooks. Call once at startup. */
export function configure(opts: AgentTaskOptions): void {
  if (opts.runner) _defaultRunner = opts.runner;
  if (opts.registry) _defaultRegistry = opts.registry;
  if (opts.hooks) _defaultHooks = opts.hooks;
}

export function agentTask(agent: AgentDef, opts?: AgentTaskOptions) {
  return task(
    { name: agent.id, plan: agent.spec.plan },
    async function run(input: AgentTaskInput): Promise<string> {
      const runner = opts?.runner ?? defaultRunner();
      const registry = opts?.registry ?? defaultRegistry();
      const hooks = opts?.hooks ?? _defaultHooks;
      const interceptor = new HookInterceptor(hooks);
      const runId = randomUUID().slice(0, 8);

      const toolNames = agent.spec.tools ?? [];
      const tools = await registry.resolve(toolNames);

      const hookCtx = { runId, agentId: agent.id };
      let result: string | undefined;
      for await (const event of runner.run({
        agentId: agent.id,
        prompt: input.message,
        systemPrompt: agent.spec.prompt,
        tools,
        maxTurns: agent.spec.budget?.maxIterations,
        model: agent.spec.model,
        sandboxId: input.sandboxId,
        interceptToolCall: (event) => interceptor.intercept(event, hookCtx),
      })) {
        if (event.type === "error") throw event.error;
        // Claude's PreToolUse bridge already ran tool-call hooks before
        // execution. The streamed copy is for runner consumers, not a second
        // policy/audit pass.
        if (event.type === "tool_call") continue;

        const hookResult = await interceptor.intercept(event, hookCtx);
        if (hookResult.action === "reject") continue;
        const finalEvent = hookResult.event ?? event;
        if (finalEvent.type === "result") {
          if (result !== undefined) {
            throw new Error(`Agent "${agent.id}" produced multiple results`);
          }
          result = finalEvent.result;
        }
      }

      if (result === undefined) {
        throw new Error(`Agent "${agent.id}" produced no result`);
      }
      return maybePutBlob(runId, agent.id, result);
    },
  );
}
