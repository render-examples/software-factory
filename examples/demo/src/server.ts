import {
  createRuntime,
  loadAgents,
  loadWorkflows,
  loadWebhooks,
  loadToolSources,
  loadHooks,
  loadRunners,
} from "@render-agents/sdk";
import { startGateway, loadConnectors } from "@render-agents/gateway";

// The project root (examples/demo) holds the convention directories
// (agents/, workflows/, tools/, …); src/ holds the per-service entrypoints.
const root = new URL("..", import.meta.url).pathname;

const toolSources = await loadToolSources(root);
const extraRunners = await loadRunners(root);
const hooks = await loadHooks(root);
const runtime = await createRuntime({ toolSources, extraRunners, hooks });
await loadAgents(root, runtime);
const workflows = await loadWorkflows(root, runtime);
const webhooks = await loadWebhooks(root);
const connectors = await loadConnectors(root);

const { port } = await startGateway({
  runtime,
  workflows,
  webhooks,
  connectors,
  defaultWorkflow: "code-review",
  defaultAgent: "assistant",
});
console.log(`gateway listening on :${port} (executionMode=${runtime.executionMode})`);
