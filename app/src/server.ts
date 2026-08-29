import { bootFactory } from "@render-factory/sdk";
import { startGateway } from "@render-factory/gateway";
import factoryDef from "../factory.js";
import { ensureWorkflowSlug } from "../lib/render.js";

ensureWorkflowSlug();

const { runtime, workflows, channels } = await bootFactory(factoryDef);

const { port } = await startGateway({
  runtime,
  workflows,
  channels,
  defaultWorkflow: "spec-to-pr",
  defaultAgent: "assistant",
});
console.log(`gateway listening on :${port}`);
