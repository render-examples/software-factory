import { validateConfig } from "./validate.js";
import { allowedActors, repository, requireEnv } from "./env.js";

/** GitHub App credentials are required — no PAT fallback. */
function requireGitHubApp(): void {
	const appId = process.env.GITHUB_APP_ID?.trim();
	const privateKey = process.env.GITHUB_APP_PRIVATE_KEY?.trim();
	const installationId = process.env.GITHUB_APP_INSTALLATION_ID?.trim();
	if (appId && privateKey && installationId) return;

	throw new Error(
		"GitHub App credentials required. Set GITHUB_APP_ID, " +
			"GITHUB_APP_PRIVATE_KEY, and GITHUB_APP_INSTALLATION_ID.",
	);
}

/** Fail fast if the gateway is misconfigured. */
export function assertGatewayEnv(): void {
	validateConfig();
	repository();
	allowedActors();
	requireEnv("GITHUB_WEBHOOK_SECRET");
	requireEnv("DATABASE_URL");
}

/** Fail fast if the workflows host is misconfigured. */
export function assertWorkflowEnv(): void {
	validateConfig();
	repository();
	requireEnv("ANTHROPIC_API_KEY");
	requireGitHubApp();
	requireEnv("RENDER_API_KEY");
	requireEnv("RENDER_WORKSPACE_ID");
	requireEnv("DATABASE_URL");
}
