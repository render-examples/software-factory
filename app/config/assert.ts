import { allowedActors, repository, requireEnv } from "./env.js";

/**
 * Each process validates what it needs at startup, so a misconfigured deploy
 * fails immediately rather than halfway through a run.
 */

export function assertGatewayEnv(): void {
	repository();
	allowedActors();
	requireEnv("GITHUB_WEBHOOK_SECRET");
	requireEnv("RENDER_WORKFLOW_SLUG");
	requireEnv("DATABASE_URL");
}

export function assertWorkflowEnv(): void {
	repository();
	requireEnv("ANTHROPIC_API_KEY");
	requireEnv("GITHUB_TOKEN");
	requireEnv("RENDER_API_KEY");
	requireEnv("RENDER_WORKSPACE_ID");
	requireEnv("DATABASE_URL");
}
