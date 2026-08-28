import { bootFactory } from "@render-factory/sdk";
import { startGateway } from "@render-factory/gateway";
import { ensureWorkflowSlug } from "../lib/render.js";

ensureWorkflowSlug();

const root = new URL("../..", import.meta.url).pathname;
const { runtime, workflows, channels } = await bootFactory(root);

const { port } = await startGateway({
  runtime,
  workflows,
  channels,
  defaultWorkflow: "spec-to-pr",
  defaultAgent: "assistant",
});
console.log(`gateway listening on :${port}`);
