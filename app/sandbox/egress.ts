import type { SandboxNetworkPolicy } from "@renderinc/sdk/experimental";
import { AGENTS } from "../agents/registry.js";
import { assertEgressHosts, type RepoContext } from "../config/index.js";

/** Clone and fetch reach GitHub over HTTPS. */
const GITHUB_HOST = "github.com";
/** install-tools.sh installs tools the base image lacks from Debian's mirror, switched to HTTPS. */
const DEBIAN_MIRROR = "deb.debian.org";

/** Every registered agent's model hosts: a sandbox opens before its task picks agents, and one sandbox can run several. */
const MODEL_HOSTS = AGENTS.flatMap((agent) => agent.harness.egress);

/**
 * The policy a task sandbox is created with. Render fixes it at creation: a restored snapshot doesn't carry one,
 * and a running sandbox's policy can't change. Under `allow-list` only HTTPS to these hosts gets out.
 */
export function taskEgress(repo: RepoContext): SandboxNetworkPolicy {
	return egressPolicy(repo, [GITHUB_HOST, ...MODEL_HOSTS]);
}

/** The snapshot builder's policy: it never calls a model, but it installs base-image tools. */
export function builderEgress(repo: RepoContext): SandboxNetworkPolicy {
	return egressPolicy(repo, [GITHUB_HOST, DEBIAN_MIRROR]);
}

/** Appended to install failures: a blocked host fails as a reset connection, which reads like a network flake. */
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
	// The API rejects a domain listed twice.
	const domains = [...new Set([...base, ...extra])];
	assertEgressHosts(domains, `sandbox egress for ${repo.fullName}`);
	return { type: "allow-list", rules: domains.map((domain) => ({ domain })) };
}
