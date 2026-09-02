import { allowedActors, repository, requireEnv } from "./env.js";

/** Fail fast if the gateway is misconfigured. */
export function assertGatewayEnv(): void {
	repository();
	allowedActors();
	requireEnv("GITHUB_WEBHOOK_SECRET");
	requireEnv("RENDER_WORKFLOW_SLUG");
	// The Render SDK reads this when the gateway dispatches a workflow task.
	requireEnv("RENDER_API_KEY");
	requireEnv("DATABASE_URL");
}

/** Fail fast if the workflows host is misconfigured. */
export function assertWorkflowEnv(): void {
	repository();
	requireEnv("ANTHROPIC_API_KEY");
	requireEnv("GITHUB_TOKEN");
	requireEnv("RENDER_API_KEY");
	requireEnv("RENDER_WORKSPACE_ID");
	requireEnv("DATABASE_URL");
}
