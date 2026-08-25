import { loadProject, runWorker } from "@render-factory/sdk";
import { resolveClient, resolveModelSpec } from "@render-factory/engine";

const root = new URL("..", import.meta.url).pathname;
const tenantId = process.env.TENANT_ID ?? "default";
const { spec } = resolveModelSpec(process.env.MODEL_TIER ?? "medium");
const model = resolveClient(spec);
const { runtime } = await loadProject(root, { tenantId, model });

const worker = runWorker(runtime);
console.log(`chat worker started (draining run_jobs, ${runtime.agentDefinitions.size} agents)`);

const shutdown = async () => {
  await worker.stop();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
