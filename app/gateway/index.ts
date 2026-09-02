/**
 * HTTP intake.
 *
 * Order matters: the HMAC signature is verified before the body is parsed, so
 * unauthenticated input never reaches a JSON parser or a schema.
 */
export { createGateway } from "./app.js";
export { readBody } from "./body.js";
export { dispatchWorkflow } from "./dispatch.js";
export { issueEventSchema, type IssueEvent } from "./schema.js";
export { verifySignature } from "./signature.js";
export { githubWebhook } from "./webhook.js";
