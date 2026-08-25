// Workflows host (Lane A). Registers the plan-tiered Render Workflows tasks that
// back the durable lane:
//   workflow@<plan>  — workflow roots (bound to workflowTaskHandler)
//   agent@<plan>     — isolated agent.task() children (bound to agentTaskHandler)
// one pair per plan referenced across the loaded agents (plus the default).
//
// Run it under the Render CLI local task server for local dev:
//   pnpm --filter @render-agents/example-demo dev:workflows
//   (== `render workflows dev -- tsx src/workflows.ts`)
// The gateway/worker then trigger these tasks by setting RENDER_USE_LOCAL_DEV=true.
//
// Without a Render Workflows runtime (plain `pnpm ... workflows`, e.g. the
// in-process Docker demo) it just validates the image loads and idles.
import { task } from "@renderinc/sdk/workflows";
import {
  loadProject,
  workflowTaskHandler,
  agentTaskHandler,
  computeRequiredPlans,
  RenderWorkflowsDispatcher,
} from "@render-agents/sdk";
import type { AgentInput, AgentOutput, AgentTaskInput, DispatchOptions } from "@render-agents/sdk";
import { resolveClient, resolveModelSpec } from "@render-agents/engine";
import { WORKFLOW_SLUG, ensureWorkflowSlug } from "./lib/render.js";

const root = new URL("..", import.meta.url).pathname;

// Same slug the gateway uses, defined in code (lib/render.ts). Env
// (RENDER_WORKFLOW_SLUG) still wins if set. Must precede loadProject.
ensureWorkflowSlug();

// Native cross-container chaining. When a workflow runs inside a Render Workflows
// task container, `agent.task()` child dispatch must go over the container's
// local task socket (a *native subtask*), NOT a top-level HTTP `runTask` to
// api.render.com. The HTTP path leaves Render unaware that the parent is awaiting
// the child, so the parent container is suspended mid-fan-out and the root
// strands at `run.started` (children finish, root never resumes). Calling the
// registered `agent@<plan>` task wrapper routes over the socket via the SDK's
// AsyncLocalStorage task context. We capture those wrappers below and dispatch
// through them; the stock HTTP path stays as the fallback (local dev / when not
// executing inside a task container).
const nativeAgentTasks = new Map<string, (input: AgentTaskInput) => Promise<AgentOutput>>();

class NativeChainingDispatcher extends RenderWorkflowsDispatcher {
  override async dispatch(
    agentName: string,
    input: AgentInput,
    opts: DispatchOptions,
  ): Promise<AgentOutput> {
    const plan = opts.plan ?? "standard";
    const native = nativeAgentTasks.get(plan);
    // Inside a task container → chain over the socket (RENDER_SDK_SOCKET_PATH is
    // set by the Render Workflows runtime). The native wrapper itself falls back
    // to a local in-process call if somehow invoked outside a task context.
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
    // Not in a container (local dev / idle) → stock HTTP runTask fallback.
    return super.dispatch(agentName, input, opts);
  }
}

const dispatcher = new NativeChainingDispatcher({ workflowSlug: WORKFLOW_SLUG });
const tenantId = process.env.TENANT_ID ?? "default";
const { spec } = resolveModelSpec(process.env.MODEL_TIER ?? "medium");
const model = resolveClient(spec);
const { runtime, workflows } = await loadProject(root, { tenantId, model, runtime: { dispatcher } });

const getDefinition = (name: string) => runtime.agentDefinitions.get(name);

// Register one task per referenced plan tier. Render binds the compute tier at
// task-definition time, so per-agent compute comes from selecting the matching
// `agent@<plan>` task; the handlers resolve definitions by name (JSON only
// crosses the task boundary — no closures). We keep each `agent@<plan>` wrapper
// so the dispatcher above can invoke it as a native subtask (socket chaining).
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

// In a Render Workflows environment (deployed, or the CLI local-dev server) the
// SDK auto-starts the task server when RENDER_SDK_SOCKET_PATH is set and keeps
// the process alive serving runs — nothing else to do here.
const underRenderRuntime = !!(process.env.RENDER_SDK_SOCKET_PATH || process.env.RENDER_USE_LOCAL_DEV);
if (underRenderRuntime) {
  console.log(`workflows host serving Render Workflows tasks: ${taskNames}`);
} else {
  // No Render runtime detected: validate the image loaded and idle so the
  // container stays up (in-process demo). A referenced interval keeps the event
  // loop alive without an unsettled top-level await (which Node exits on).
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
