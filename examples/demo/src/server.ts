import { loadProject } from "@render-agents/sdk";
import { resolveClient, resolveModelSpec } from "@render-agents/engine";
import { startGateway } from "@render-agents/gateway";
import { ensureWorkflowSlug } from "./lib/render.js";

const root = new URL("..", import.meta.url).pathname;

ensureWorkflowSlug();

const tenantId = process.env.TENANT_ID ?? "default";
const { spec } = resolveModelSpec(process.env.MODEL_TIER ?? "medium");
const model = resolveClient(spec);
const { runtime, workflows, channels } = await loadProject(root, { tenantId, model });

const { port } = await startGateway({
  runtime,
  workflows,
  channels,
  defaultWorkflow: "code-review",
  defaultAgent: "assistant",
});
console.log(`gateway listening on :${port} (executionMode=${runtime.executionMode})`);
