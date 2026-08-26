import {
  createRuntime,
  loadAgents,
  bindWorkflow,
} from "@render-factory/sdk";
import { resolveClient, resolveModelSpec } from "@render-factory/engine";
import { startGateway } from "@render-factory/gateway";
import { ensureWorkflowSlug } from "../lib/render.js";

// Explicit tool imports
import sandboxToolSource from "../tools/sandbox/index.js";
import deployToolSource from "../tools/deploy/index.js";
import startWorkflowToolSource, { bindWorkflows, bindStore } from "../tools/start_workflow/index.js";
import githubReposToolSource from "../tools/github_repos/index.js";
import renderMcpToolSource from "../tools/render/index.js";
import getActivityToolSource, { bindActivityRuntime } from "../tools/get_activity/index.js";

// Explicit workflow imports
import chatTurnWorkflow from "../workflows/chat-turn/index.js";
import specToPrWorkflow from "../workflows/spec-to-pr/index.js";
import prReviewWorkflow from "../workflows/pr-review/index.js";
import prFixWorkflow from "../workflows/pr-fix/index.js";

// Explicit channel imports
import slackChannel from "../channels/slack.js";
import githubChannel from "../channels/github.js";

const root = new URL("../..", import.meta.url).pathname;

ensureWorkflowSlug();

const tenantId = process.env.TENANT_ID ?? "default";
const { spec } = resolveModelSpec(process.env.MODEL_TIER ?? "medium");
const model = resolveClient(spec);

const toolSources = new Map([
  ["sandbox", sandboxToolSource],
  ["deploy", deployToolSource],
  ["start_workflow", startWorkflowToolSource],
  ["github_repos", githubReposToolSource],
  ["render", renderMcpToolSource],
  ["get_activity", getActivityToolSource],
]);

const channels = new Map([
  ["slack", slackChannel],
  ["github", githubChannel],
]);

const runtime = await createRuntime({ tenantId, model, toolSources });

// Load agents from .md files
await loadAgents(root, runtime);

// Bind workflows
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
bindActivityRuntime(runtime);

const { port } = await startGateway({
  runtime,
  workflows,
  channels,
  defaultWorkflow: "spec-to-pr",
  defaultAgent: "assistant",
});
console.log(`gateway listening on :${port}`);
