import config, { type FactoryConfig, type RepoConfig } from "../../factory.config.js";

export { config, type RepoConfig };

/** A lowercase hostname with at least one dot, as the Sandbox egress rules take it; `*.` only as the leftmost label. */
const EGRESS_HOST = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** Throws naming the first host that isn't a bare hostname: no scheme, port, path, or uppercase. */
export function assertEgressHosts(hosts: readonly string[], where: string): void {
	for (const host of hosts) {
		if (!EGRESS_HOST.test(host)) {
			throw new Error(`${where}: egress host ${JSON.stringify(host)} must be a lowercase hostname such as registry.npmjs.org or *.example.com`);
		}
	}
}

/** Checks what the type system can't. Runs when this module loads, so an invalid config stops every service at startup. */
export function validateConfig(c: FactoryConfig): void {
	for (const [fullName, repo] of Object.entries(c.repos)) {
		if (repo.egress !== undefined && repo.egress !== "allow-all") assertEgressHosts(repo.egress, `factory.config.ts repos["${fullName}"]`);
	}
}

validateConfig(config);

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
