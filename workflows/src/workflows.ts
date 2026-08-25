import { task } from "@renderinc/sdk/workflows";
import {
  loadProject,
  workflowTaskHandler,
  agentTaskHandler,
  computeRequiredPlans,
  RenderWorkflowsDispatcher,
  driveAgentTurn,
  deliverForRun,
} from "@render-factory/sdk";
import { RunPaused } from "@render-factory/engine";
import type { AgentInput, AgentOutput, AgentTaskInput, DispatchOptions } from "@render-factory/sdk";
import { resolveClient, resolveModelSpec } from "@render-factory/engine";
import { WORKFLOW_SLUG, ensureWorkflowSlug } from "../lib/render.js";

const root = new URL("..", import.meta.url).pathname;

ensureWorkflowSlug();

const nativeAgentTasks = new Map<string, (input: AgentTaskInput) => Promise<AgentOutput>>();

class NativeChainingDispatcher extends RenderWorkflowsDispatcher {
  override async dispatch(
    agentName: string,
    input: AgentInput,
    opts: DispatchOptions,
  ): Promise<AgentOutput> {
    const plan = opts.plan ?? "standard";
    const native = nativeAgentTasks.get(plan);
    if (process.env.RENDER_SDK_SOCKET_PATH && native) {
      return native({
        agentName,
        input,
        runId: opts.runId,
        parentSpanId: opts.parentSpanId,
        userId: opts.userId,
        threadId: opts.threadId,
        depth: opts.depth ?? 0,
        idempotencyKey: opts.idempotencyKey,
        cancelScopeId: opts.cancelScopeId,
      });
    }
    return super.dispatch(agentName, input, opts);
  }
}

const dispatcher = new NativeChainingDispatcher({ workflowSlug: WORKFLOW_SLUG });
const tenantId = process.env.TENANT_ID ?? "default";
const { spec } = resolveModelSpec(process.env.MODEL_TIER ?? "medium");
const model = resolveClient(spec);
const { runtime, workflows } = await loadProject(root, { tenantId, model, runtime: { dispatcher } });

const getDefinition = (name: string) => runtime.agentDefinitions.get(name);

const plans = computeRequiredPlans([...runtime.agentDefinitions.values()]);
for (const plan of plans) {
  const agentTask = task(
    { name: `agent@${plan}`, plan },
    (input: Parameters<typeof agentTaskHandler>[0]) => agentTaskHandler(input, runtime, getDefinition),
  );
  nativeAgentTasks.set(plan, agentTask as (input: AgentTaskInput) => Promise<AgentOutput>);
  task(
    { name: `workflow@${plan}`, plan },
    (args: Parameters<typeof workflowTaskHandler>[0]) => workflowTaskHandler(args, workflows),
  );
}

// Chat-turn task: drives one interactive agent turn + delivers the reply.
// Replaces the warm worker — the gateway dispatches here instead of enqueuing
// to run_jobs. The run's opening events (run.started, message.user) are already
// in the log when this task fires.
task({ name: "chat-turn", plan: "standard" }, async (args: { runId: string }) => {
  try {
    await driveAgentTurn(runtime, args.runId);
  } catch (err) {
    if (!(err instanceof RunPaused)) throw err;
  }
  await deliverForRun(runtime, args.runId);
  return { runId: args.runId, status: "delivered" };
});

const taskNames = [...plans.flatMap((p) => [`agent@${p}`, `workflow@${p}`]), "chat-turn"].join(", ");

const underRenderRuntime = !!(process.env.RENDER_SDK_SOCKET_PATH || process.env.RENDER_USE_LOCAL_DEV);
if (underRenderRuntime) {
  console.log(`workflows host serving Render Workflows tasks: ${taskNames}`);
} else {
  console.log(
    `workflows host ready (idle; no Render Workflows runtime — set RENDER_USE_LOCAL_DEV or run under \`render workflows dev\`). ` +
      `${runtime.agentDefinitions.size} agents, ${workflows.size} workflows, tasks: ${taskNames}`,
  );
  const keepAlive = setInterval(() => {}, 1 << 30);
  const shutdown = (): void => {
    clearInterval(keepAlive);
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
