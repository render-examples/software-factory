// Chat worker (Lane B). A long-lived, warm process that drains the Postgres
// `run_jobs` queue and drives interactive agent turns + HITL resumes IN-PROCESS
// for low latency. Shares the database with the gateway; scale horizontally by
// running more instances.
import { loadProject, runWorker } from "@render-agents/sdk";

const root = new URL("..", import.meta.url).pathname;
const { runtime } = await loadProject(root);

const worker = runWorker(runtime);
console.log(`chat worker started (draining run_jobs, ${runtime.agentDefinitions.size} agents)`);

const shutdown = async () => {
  await worker.stop();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
