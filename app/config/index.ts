import config, { type FactoryConfig, type RepoConfig } from "../../factory.config.js";

export { config, type RepoConfig };

const EGRESS_HOST = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export function assertEgressHosts(hosts: readonly string[], where: string): void {
	for (const host of hosts) {
		if (!EGRESS_HOST.test(host)) {
			throw new Error(`${where}: egress host ${JSON.stringify(host)} must be a lowercase hostname such as registry.npmjs.org or *.example.com`);
		}
	}
}

export function validateConfig(c: FactoryConfig): void {
	for (const [fullName, repo] of Object.entries(c.repos)) {
		if (repo.egress !== undefined && repo.egress !== "allow-all") assertEgressHosts(repo.egress, `factory.config.ts repos["${fullName}"]`);
	}
}

validateConfig(config);

export interface RepoContext {
	owner: string;
	name: string;
	fullName: string;
	installationId: number;
	config: RepoConfig;
}

export function resolveRepo(fullName: string, installationId: number): RepoContext | null {
	const repoConfig = config.repos[fullName];
	if (!repoConfig) return null;
	const [owner, name] = fullName.split("/");
	if (!owner || !name) return null;
	return { owner, name, fullName, installationId, config: repoConfig };
}

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

export const TASKS = {
	triage: "triage",
	specToPr: "spec-to-pr",
	prReview: "pr-review",
	autopilot: "autopilot",
	cancel: "cancel",
	refreshSnapshot: "refresh-snapshot",
} as const;
export type TaskName = (typeof TASKS)[keyof typeof TASKS];
