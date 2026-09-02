/**
 * The eight agents, in pipeline order.
 *
 * Each becomes its own Render Workflows task (see app/tasks), so a run shows
 * up on the platform as a timeline of named agent executions rather than one
 * opaque block. Agents that only reason about their input declare no tools.
 *
 * Agents that must emit JSON say so in their prompt; the workflow validates
 * the output against a Zod schema in app/contracts and never trusts it raw.
 */
export { triage } from "./triage.js";
export { analyst } from "./analyst.js";
export { implementer } from "./implementer.js";
export { selfReview } from "./self-review.js";
export { security } from "./security.js";
export { correctness } from "./correctness.js";
export { tests } from "./tests.js";
export { judge } from "./judge.js";
