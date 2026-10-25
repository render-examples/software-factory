/** What the factory needs from GitHub and from each service's environment, in one place for setup and doctor. */
import { config } from "../../app/config/index.js";
import { WORKING_LABEL } from "../../app/claims/status.js";

/**
 * Repository permissions the App requests. Each is used by app/:
 * - contents: write — Git Data API publishing (blobs, trees, commits, refs) and read-only clone tokens.
 * - issues: write — comments, status labels, the label timeline, and creating labels.
 * - pull_requests: write — opening draft PRs, reading diffs and files, posting COMMENT reviews.
 * - metadata: read — collaborator permission checks; GitHub grants it to every App.
 * No `workflows` permission: publishing refuses changes under .github/workflows.
 */
export const REQUIRED_PERMISSIONS: Readonly<Record<string, "read" | "write">> = {
	contents: "write",
	issues: "write",
	pull_requests: "write",
	metadata: "read",
};

/** Webhook events the gateway routes (app/gateway/routes.ts). */
export const REQUIRED_EVENTS: readonly string[] = ["issues", "issue_comment", "pull_request", "push"];

export const WEBHOOK_PATH = "/webhooks/github";

export interface LabelSpec {
	name: string;
	color: string;
	description: string;
	/** A trigger label must exist so people can apply it; the working label is created on demand. */
	trigger: boolean;
}

export const LABELS: readonly LabelSpec[] = [
	{
		name: config.labels.triage,
		color: "1d76db",
		description: "software-factory: triage this issue and draft a spec",
		trigger: true,
	},
	{
		name: config.labels.specApproved,
		color: "0e8a16",
		description: "software-factory: implement the approved spec and open a draft PR",
		trigger: true,
	},
	{
		name: config.labels.prReview,
		color: "5319e7",
		description: "software-factory: review this pull request",
		trigger: true,
	},
	{
		name: config.labels.autopilot,
		color: "c5def5",
		description: "software-factory: run through a reviewed draft pull request",
		trigger: true,
	},
	{ name: WORKING_LABEL, color: "fbca04", description: "software-factory is working on this", trigger: false },
];

export type Service = "gateway" | "workflows";

/** Each service's env vars, exactly as render.yaml declares them. */
export const SERVICE_ENV: Readonly<Record<Service, readonly string[]>> = {
	gateway: ["GITHUB_WEBHOOK_SECRET", "RENDER_API_KEY", "RENDER_WORKFLOW_SLUG"],
	workflows: ["RENDER_API_KEY", "RENDER_WORKSPACE_ID", "GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "ANTHROPIC_API_KEY"],
};

/** Values doctor must never print. */
export const SECRET_ENV: readonly string[] = ["GITHUB_WEBHOOK_SECRET", "RENDER_API_KEY", "GITHUB_APP_PRIVATE_KEY"];

const LEVELS = ["none", "read", "write", "admin"];

/** Required permissions the granted set lacks, as "name:level" strings. */
export function missingPermissions(granted: Record<string, string> | undefined): string[] {
	const have = granted ?? {};
	return Object.entries(REQUIRED_PERMISSIONS)
		.filter(([name, level]) => LEVELS.indexOf(have[name] ?? "none") < LEVELS.indexOf(level))
		.map(([name, level]) => `${name}:${level}`);
}

export function missingEvents(subscribed: readonly string[] | undefined): string[] {
	const have = new Set(subscribed ?? []);
	return REQUIRED_EVENTS.filter((event) => !have.has(event));
}
