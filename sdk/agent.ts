/**
 * Agent() — config describing an agent (prompt, tools, budget).
 * agentTask() — turns an Agent into a Render Workflows task.
 */
import { randomUUID } from "node:crypto";
import { task } from "@renderinc/sdk/workflows";
import {
  factoryStore,
  type ExecutionHandle,
  type FactoryStore,
} from "#factory/store";
import { BLOB_THRESHOLD } from "./blobs.js";
import type {
  Environment,
  SerializedEnvironment,
} from "./environment.js";
import type { SandboxProvider } from "./sandbox/index.js";
import type { ResolvedTool } from "./tools.js";
import { ClaudeRunner } from "./runners/index.js";
import type { AgentRunner } from "./runner.js";
import { HookInterceptor, type Hook } from "./hooks.js";

const AGENT_TASK_MAX_ATTEMPTS = 4;

export interface AgentSpec {
  readonly id: string;
  readonly description?: string;
  readonly prompt: string;
  readonly tools?: readonly ResolvedTool[];
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
  /** Workflow-owned execution environment; never supplied by the model. */
  environment?: SerializedEnvironment;
  /** Workflow-owned logical run binding; never supplied by the model. */
  run?: AgentRunContext;
}

export interface AgentRunContext {
  id: string;
  rootRunId: string;
  parentRunId?: string;
  parentStepKey?: string;
}

export interface AgentTaskOptions {
  runner?: AgentRunner;
  hooks?: Hook[];
  store?: FactoryStore;
  /** Resolves workflow-owned sandbox locators into live sandboxes. */
  sandboxProvider?: SandboxProvider;
}

let _defaultRunner: AgentRunner | undefined;
let _defaultHooks: Hook[] = [];
let _defaultStore: FactoryStore | undefined;
let _defaultSandboxProvider: SandboxProvider | undefined;

function defaultRunner(): AgentRunner {
  _defaultRunner ??= new ClaudeRunner();
  return _defaultRunner;
}

function defaultStore(): FactoryStore {
  _defaultStore ??= factoryStore();
  return _defaultStore;
}

/** Override the default runner, hooks, store, and/or sandbox provider. */
export function configure(opts: AgentTaskOptions): void {
  if (opts.runner) _defaultRunner = opts.runner;
  if (opts.hooks) _defaultHooks = opts.hooks;
  if (opts.store) _defaultStore = opts.store;
  if (opts.sandboxProvider) _defaultSandboxProvider = opts.sandboxProvider;
}

/**
 * Resolve serialized locators into live capabilities. Runs once per agent run
 * so tools share a single sandbox connection instead of reconnecting per call.
 */
async function rehydrateEnvironment(
  agentId: string,
  serialized: SerializedEnvironment | undefined,
  provider: SandboxProvider | undefined,
): Promise<Environment | undefined> {
  if (!serialized) return undefined;
  if (!serialized.sandbox) return { workspace: serialized.workspace };
  if (!provider) {
    throw new Error(
      `Agent "${agentId}" was given a sandbox binding but no sandbox provider is configured; ` +
        "call configure({ sandboxProvider }) at startup",
    );
  }
  return {
    sandbox: await provider.connect(serialized.sandbox.id),
    workspace: serialized.workspace,
  };
}

export function agentTask(agent: AgentDef, opts?: AgentTaskOptions) {
  return task(
    { name: agent.id, plan: agent.spec.plan },
    async function run(input: AgentTaskInput): Promise<string> {
      const runner = opts?.runner ?? defaultRunner();
      const hooks = opts?.hooks ?? _defaultHooks;
      const store = opts?.store ?? defaultStore();
      const sandboxProvider =
        opts?.sandboxProvider ?? _defaultSandboxProvider;
      const interceptor = new HookInterceptor(hooks);
      const runId = input.run?.id ?? randomUUID();
      const tools = agent.spec.tools ?? [];

      await store.runs.ensureRun({
        id: runId,
        rootRunId: input.run?.rootRunId ?? runId,
        parentRunId: input.run?.parentRunId,
        parentStepKey: input.run?.parentStepKey,
        kind: "agent",
        name: agent.id,
        triggerType: input.run ? "workflow.task" : "direct",
      });
      const prior = await store.runs.getTerminal<unknown>(runId);
      if (prior.found) {
        if (typeof prior.value === "string") return prior.value;
        throw new Error(`Agent run "${runId}" is already terminal`);
      }

      const executionId = randomUUID();
      const claimed = await store.runs.beginExecution(runId, executionId, 30);
      if (claimed.kind === "busy") {
        throw new Error(`Agent run "${runId}" is already executing`);
      }
      let execution: ExecutionHandle = claimed.execution;
      let heartbeatError: Error | undefined;
      const heartbeat = setInterval(() => {
        void store.runs
          .refreshExecution(execution, 30)
          .then((refreshed) => {
            execution = refreshed;
          })
          .catch((error) => {
            heartbeatError =
              error instanceof Error ? error : new Error(String(error));
          });
      }, 10_000);
      heartbeat.unref();

      let result: string | undefined;
      try {
        const environment = await rehydrateEnvironment(
          agent.id,
          input.environment,
          sandboxProvider,
        );
        const hookCtx = { runId, agentId: agent.id, environment };

        for await (const event of runner.run({
          agentId: agent.id,
          prompt: input.message,
          systemPrompt: agent.spec.prompt,
          tools,
          maxTurns: agent.spec.budget?.maxIterations,
          model: agent.spec.model,
          environment,
          interceptToolCall: (event) => interceptor.intercept(event, hookCtx),
        })) {
          if (event.type === "error") {
            await interceptor.intercept(event, hookCtx);
            throw event.error;
          }
          // Claude's PreToolUse bridge already ran tool-call hooks before
          // execution. The streamed copy is for runner consumers, not a second
          // policy/audit pass.
          if (event.type === "tool_call") continue;

          const hookResult = await interceptor.intercept(event, hookCtx);
          if (hookResult.action === "reject") continue;
          const finalEvent = hookResult.event ?? event;
          if (finalEvent.type === "usage") {
            await store.runs.recordUsage(
              runId,
              finalEvent.usage.inputTokens,
              finalEvent.usage.outputTokens,
              finalEvent.usage.model,
              execution,
            );
          }
          if (finalEvent.type === "result") {
            if (result !== undefined) {
              throw new Error(`Agent "${agent.id}" produced multiple results`);
            }
            result = finalEvent.result;
          }
        }

        if (heartbeatError) throw heartbeatError;
        if (result === undefined) {
          throw new Error(`Agent "${agent.id}" produced no result`);
        }
        const storedResult =
          result.length <= BLOB_THRESHOLD
            ? result
            : await store.artifacts.put({
                runId,
                namespace: agent.id,
                content: result,
                ttlSeconds: 7 * 24 * 60 * 60,
              });
        await store.completeRun({
          runId,
          execution,
          status: "completed",
          result: storedResult,
        });
        return storedResult;
      } catch (error) {
        const failureCount = await store.runs.incrementFailureCount(
          runId,
          execution,
        );
        if (failureCount >= AGENT_TASK_MAX_ATTEMPTS) {
          await store.completeRun({
            runId,
            execution,
            status: "failed",
            errorCode: "attempts_exhausted",
            result: { status: "failed" },
          });
        }
        throw error;
      } finally {
        clearInterval(heartbeat);
        await store.runs.releaseExecution(execution).catch(() => {});
      }
    },
  );
}
