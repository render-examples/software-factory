import config, { type ModelTier, type RepoConfig } from "../../factory.config.js";

export { config, type ModelTier, type RepoConfig };

/** One repository a run acts on, resolved from the webhook that started it. */
export interface RepoContext {
	owner: string;
	name: string;
	/** "owner/name" */
	fullName: string;
	/** The GitHub App installation that delivered the webhook; tokens are minted for it. */
	installationId: number;
	config: RepoConfig;
}

/** The configured repository, or null when the factory doesn't act on it. */
export function resolveRepo(fullName: string, installationId: number): RepoContext | null {
	const repoConfig = config.repos[fullName];
	if (!repoConfig) return null;
	const [owner, name] = fullName.split("/");
	if (!owner || !name) return null;
	return { owner, name, fullName, installationId, config: repoConfig };
}

/** Like resolveRepo, but throws: for tasks, whose input the gateway already checked. */
export function requireRepo(fullName: string, installationId: number): RepoContext {
	const repo = resolveRepo(fullName, installationId);
	if (!repo) throw new Error(`${fullName} is not configured in factory.config.ts`);
	return repo;
}

export function modelFor(tier: ModelTier): { provider: string; model: string } {
	const id = config.models[tier];
	const slash = id.indexOf("/");
	if (slash <= 0) throw new Error(`models.${tier} must be "provider/model", got "${id}"`);
	return { provider: id.slice(0, slash), model: id.slice(slash + 1) };
}

export function requireEnv(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is not set`);
	return value;
}

/** Task names, shared by the gateway (which starts them) and the Workflows service (which registers them). */
export const TASKS = {
	triage: "triage",
	specToPr: "spec-to-pr",
	prReview: "pr-review",
	autopilot: "autopilot",
	cancel: "cancel",
	refreshSnapshot: "refresh-snapshot",
} as const;
export type TaskName = (typeof TASKS)[keyof typeof TASKS];
