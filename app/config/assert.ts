import { allowedActors, repository, requireEnv } from "./env.js";

/** Either a GitHub App installation or a fine-grained PAT, not neither. */
function requireGitHubCredentials(): void {
	const app =
		process.env.GITHUB_APP_ID?.trim() &&
		process.env.GITHUB_APP_PRIVATE_KEY?.trim() &&
		process.env.GITHUB_APP_INSTALLATION_ID?.trim();
	if (app || process.env.GITHUB_TOKEN?.trim()) return;

	throw new Error(
		"No GitHub credentials. Set GITHUB_TOKEN, or GITHUB_APP_ID, " +
			"GITHUB_APP_PRIVATE_KEY, and GITHUB_APP_INSTALLATION_ID.",
	);
}

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
	requireGitHubCredentials();
	requireEnv("RENDER_API_KEY");
	requireEnv("RENDER_WORKSPACE_ID");
	requireEnv("DATABASE_URL");
}
