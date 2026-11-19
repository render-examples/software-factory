import { AGENTS } from "../../app/agents/index.js";
import { config } from "../../app/config/index.js";
import { WORKING_LABEL } from "../../app/runs/index.js";

export const REQUIRED_PERMISSIONS: Readonly<Record<string, "read" | "write">> = {
	contents: "write",
	issues: "write",
	pull_requests: "write",
	metadata: "read",
};

export const REQUIRED_EVENTS: readonly string[] = ["issues", "issue_comment", "pull_request", "push"];

export const WEBHOOK_PATH = "/webhooks/github";

export interface LabelSpec {
	name: string;
	color: string;
	description: string;
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

export const HARNESS_KEY_ENV: readonly string[] = [...new Set(AGENTS.map((agent) => agent.harness.credential))];

export const SERVICE_ENV: Readonly<Record<Service, readonly string[]>> = {
	gateway: ["GITHUB_WEBHOOK_SECRET", "EVENTS_READ_TOKEN", "RENDER_API_KEY", "RENDER_WORKFLOW_SLUG", "DATABASE_URL"],
	workflows: ["RENDER_API_KEY", "RENDER_WORKSPACE_ID", "GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "DATABASE_URL", ...HARNESS_KEY_ENV],
};

export interface EnvGroupSpec {
	name: string;
	services: readonly Service[];
	keys: readonly string[];
}

export const ENV_GROUPS: readonly EnvGroupSpec[] = [
	{ name: "software-factory-shared", services: ["gateway", "workflows"], keys: ["RENDER_API_KEY"] },
	{ name: "software-factory-gateway", services: ["gateway"], keys: ["GITHUB_WEBHOOK_SECRET", "EVENTS_READ_TOKEN"] },
	{
		name: "software-factory-workflows",
		services: ["workflows"],
		keys: ["RENDER_WORKSPACE_ID", "GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", ...HARNESS_KEY_ENV],
	},
];

export const WORKFLOWS_DATABASE_GROUP: EnvGroupSpec = { name: "software-factory-workflows", services: ["workflows"], keys: ["DATABASE_URL"] };

export function envGroupFor(service: Service, key: string): EnvGroupSpec | undefined {
	return ENV_GROUPS.find((group) => group.services.includes(service) && group.keys.includes(key));
}

export const SECRET_ENV: readonly string[] = [
	"GITHUB_WEBHOOK_SECRET",
	"EVENTS_READ_TOKEN",
	"RENDER_API_KEY",
	"GITHUB_APP_PRIVATE_KEY",
	"DATABASE_URL",
];

const LEVELS = ["none", "read", "write", "admin"];

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
