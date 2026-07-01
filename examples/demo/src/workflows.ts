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
  createRuntime,
  loadAgents,
  loadWorkflows,
  loadToolSources,
  loadHooks,
  loadRunners,
  workflowTaskHandler,
  agentTaskHandler,
  computeRequiredPlans,
} from "@render-agents/sdk";

const root = new URL("..", import.meta.url).pathname;
const toolSources = await loadToolSources(root);
const extraRunners = await loadRunners(root);
const hooks = await loadHooks(root);
const runtime = await createRuntime({ toolSources, extraRunners, hooks });
await loadAgents(root, runtime);
const workflows = await loadWorkflows(root, runtime);

const getDefinition = (name: string) => runtime.agentDefinitions.get(name);

// Register one task per referenced plan tier. Render binds the compute tier at
// task-definition time, so per-agent compute comes from selecting the matching
// `agent@<plan>` task; the handlers resolve definitions by name (JSON only
// crosses the task boundary — no closures).
const plans = computeRequiredPlans([...runtime.agentDefinitions.values()]);
for (const plan of plans) {
  task(
    { name: `agent@${plan}`, plan },
    (input: Parameters<typeof agentTaskHandler>[0]) => agentTaskHandler(input, runtime, getDefinition),
  );
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
