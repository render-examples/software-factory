import type { SandboxNetworkPolicy } from "@renderinc/sdk/experimental";
import { AGENTS } from "../agents/index.js";
import { assertEgressHosts, type RepoContext } from "../config/index.js";

const GITHUB_HOST = "github.com";
const DEBIAN_MIRROR = "deb.debian.org";

const MODEL_HOSTS = AGENTS.flatMap((agent) => agent.harness.egress);

export function taskEgress(repo: RepoContext): SandboxNetworkPolicy {
	return egressPolicy(repo, [GITHUB_HOST, ...MODEL_HOSTS]);
}

export function builderEgress(repo: RepoContext): SandboxNetworkPolicy {
	return egressPolicy(repo, [GITHUB_HOST, DEBIAN_MIRROR]);
}

export function egressHint(repo: RepoContext, policy: SandboxNetworkPolicy): string {
	if (policy.type !== "allow-list") return "";
	return (
		`\nSandbox egress is limited to ${policy.rules.map((rule) => rule.domain).join(", ")}. ` +
		`If install needs another host, add it to egress for "${repo.fullName}" in factory.config.ts.`
	);
}

function egressPolicy(repo: RepoContext, base: readonly string[]): SandboxNetworkPolicy {
	const extra = repo.config.egress ?? [];
	if (extra === "allow-all") return { type: "allow-all" };
	const domains = [...new Set([...base, ...extra])];
	assertEgressHosts(domains, `sandbox egress for ${repo.fullName}`);
	return { type: "allow-list", rules: domains.map((domain) => ({ domain })) };
}
