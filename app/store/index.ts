/**
 * Postgres — one table recording what each run did.
 *
 * Render's filesystem is ephemeral, so anything that must outlive a single
 * process lives here. This deliberately does not implement durable workflow
 * steps: a retry re-runs the pipeline from the top.
 *
 * The schema is in app/sql and is applied by the gateway's preDeployCommand.
 */
export { db, ping } from "./pool.js";
export { claimRun, finishRun, getRun, setRunBranch } from "./runs.js";
export type { RunRecord, RunStatus } from "./types.js";
