import { loadProject } from "@render-factory/sdk";
import { resolveClient, resolveModelSpec } from "@render-factory/engine";
import { startGateway } from "@render-factory/gateway";
import { ensureWorkflowSlug } from "../lib/render.js";
import { bindWorkflows } from "../tools/start_workflow/index.js";

const root = new URL("..", import.meta.url).pathname;

ensureWorkflowSlug();

const tenantId = process.env.TENANT_ID ?? "default";
const { spec } = resolveModelSpec(process.env.MODEL_TIER ?? "medium");
const model = resolveClient(spec);
const { runtime, workflows, channels } = await loadProject(root, { tenantId, model });

bindWorkflows(workflows);

const { port } = await startGateway({
  runtime,
  workflows,
  channels,
  defaultWorkflow: "spec-to-pr",
  defaultAgent: "assistant",
});
console.log(`gateway listening on :${port}`);
