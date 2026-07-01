// Chat worker (Lane B). A long-lived, warm process that drains the Postgres
// `run_jobs` queue and drives interactive agent turns + HITL resumes IN-PROCESS
// for low latency. Shares the database with the gateway; scale horizontally by
// running more instances.
import {
  createRuntime,
  loadAgents,
  loadToolSources,
  loadHooks,
  loadRunners,
  runWorker,
} from "@render-agents/sdk";

const root = new URL("..", import.meta.url).pathname;
const toolSources = await loadToolSources(root);
const extraRunners = await loadRunners(root);
const hooks = await loadHooks(root);
const runtime = await createRuntime({ toolSources, extraRunners, hooks });
await loadAgents(root, runtime);

const worker = runWorker(runtime);
console.log(`chat worker started (draining run_jobs, ${runtime.agentDefinitions.size} agents)`);

const shutdown = async () => {
  await worker.stop();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
