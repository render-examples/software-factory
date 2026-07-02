import { loadProject } from "@render-agents/sdk";
import { startGateway, loadConnectors } from "@render-agents/gateway";
import { ensureWorkflowSlug } from "./lib/render.js";

// The project root (examples/demo) holds the convention directories
// (agents/, workflows/, tools/, …); src/ holds the per-service entrypoints.
// `loadProject` discovers + wires runtime/agents/workflows/webhooks; connectors
// live in the gateway package (the SDK can't depend on it), so load them here.
const root = new URL("..", import.meta.url).pathname;

// Lane A trigger address: the gateway dispatches workflow roots to the separate
// Workflows service as `<slug>/workflow@<plan>`. The slug lives in code (see
// lib/render.ts), so deploy needs no RENDER_WORKFLOW_SLUG env var — only
// RENDER_API_KEY (which also toggles Lane A on). Must precede loadProject
// (createRuntime reads the slug when selecting the dispatcher).
ensureWorkflowSlug();

const { runtime, workflows, webhooks } = await loadProject(root);
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
