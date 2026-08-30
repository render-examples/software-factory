/**
 * Gateway entrypoint. Creates a runtime for thread management, HITL, and events.
 * Dispatches agent work to the Render Workflows host — does not execute agents itself.
 */
import { createRuntime } from "@render-factory/sdk";
import { resolveModelSpec, resolveClient } from "@render-factory/engine";
import { startGateway } from "@render-factory/gateway";

const tenantId = process.env.TENANT_ID ?? "default";
const { spec } = resolveModelSpec(process.env.MODEL_TIER ?? "medium");
const model = resolveClient(spec);

const runtime = await createRuntime({ tenantId, model });

const { port } = await startGateway({
  runtime,
  defaultWorkflow: "spec-to-pr",
  defaultAgent: "assistant",
});
console.log(`gateway listening on :${port}`);
