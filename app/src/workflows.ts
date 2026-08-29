import { task } from "@renderinc/sdk/workflows";
import {
  bootFactory,
  workflowTaskHandler,
  agentTaskHandler,
  computeRequiredPlans,
  RenderWorkflowsDispatcher,
} from "@render-factory/sdk";
import type { AgentInput, AgentOutput, AgentTaskInput, DispatchOptions } from "@render-factory/sdk";
import { WORKFLOW_SLUG, ensureWorkflowSlug } from "../lib/render.js";

ensureWorkflowSlug();

// --- Dispatcher ---

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

const root = new URL("../..", import.meta.url).pathname;
const { runtime, workflows } = await bootFactory(root, {
  runtime: { dispatcher },
});

const getDefinition = (name: string) => runtime.agentDefinitions.get(name);

// --- Task Registration ---

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

const taskNames = plans.flatMap((p) => [`agent@${p}`, `workflow@${p}`]).join(", ");

// --- Startup ---

const underRenderRuntime = !!(process.env.RENDER_SDK_SOCKET_PATH || process.env.RENDER_USE_LOCAL_DEV);
if (underRenderRuntime) {
  console.log(`workflows host serving Render Workflows tasks: ${taskNames}`);
} else {
  console.log(
    `workflows host ready (idle; no Render Workflows runtime). ` +
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
