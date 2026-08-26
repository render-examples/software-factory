import { task } from "@renderinc/sdk/workflows";
import {
  createRuntime,
  loadAgents,
  bindWorkflow,
  workflowTaskHandler,
  agentTaskHandler,
  computeRequiredPlans,
  RenderWorkflowsDispatcher,
} from "@render-factory/sdk";
import type { AgentInput, AgentOutput, AgentTaskInput, DispatchOptions } from "@render-factory/sdk";
import { resolveClient, resolveModelSpec } from "@render-factory/engine";
import { WORKFLOW_SLUG, ensureWorkflowSlug } from "../lib/render.js";

// Explicit tool imports
import sandboxToolSource from "../tools/sandbox/index.js";
import deployToolSource from "../tools/deploy/index.js";
import startWorkflowToolSource, { bindWorkflows, bindStore } from "../tools/start_workflow/index.js";
import githubReposToolSource from "../tools/github_repos/index.js";
import renderMcpToolSource from "../tools/render/index.js";

// Explicit workflow imports
import chatTurnWorkflow from "../workflows/chat-turn/index.js";
import specToPrWorkflow from "../workflows/spec-to-pr/index.js";
import prReviewWorkflow from "../workflows/pr-review/index.js";
import prFixWorkflow from "../workflows/pr-fix/index.js";

// Explicit channel imports (needed for outbound delivery in chat-turn)
import slackChannel from "../channels/slack.js";

const root = new URL("../..", import.meta.url).pathname;

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

const toolSources = new Map([
  ["sandbox", sandboxToolSource],
  ["deploy", deployToolSource],
  ["start_workflow", startWorkflowToolSource],
  ["github_repos", githubReposToolSource],
  ["render", renderMcpToolSource],
]);

const channels = new Map([["slack", slackChannel]]);
const runtime = await createRuntime({ tenantId, model, toolSources, dispatcher, channels });

// Load agents from .md files (plain fs.readFile, no .ts import)
await loadAgents(root, runtime);

// Bind workflows explicitly
const workflows = new Map([
  ["chat-turn", chatTurnWorkflow],
  ["spec-to-pr", specToPrWorkflow],
  ["pr-review", prReviewWorkflow],
  ["pr-fix", prFixWorkflow],
]);
for (const [name, wf] of workflows) bindWorkflow(wf, name, runtime);

// Late-bind the workflow registry and store to the start_workflow tool
bindWorkflows(workflows);
bindStore(runtime.store);

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

const taskNames = plans.flatMap((p) => [`agent@${p}`, `workflow@${p}`]).join(", ");

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
