import { factoryConfig } from "../../factory.config.js";
import { knownSpecialistNames } from "../agents/reviewers/registry.js";

/** Validate factoryConfig at startup. Throws on the first broken rule. */
export function validateConfig(): void {
	if (factoryConfig.repos.length === 0) {
		throw new Error("factoryConfig.repos must have at least one entry");
	}
	if (factoryConfig.repos.length > 1) {
		throw new Error("factoryConfig.repos must have exactly one entry in 0.1.0");
	}

	const repo = factoryConfig.repos[0];
	if (!repo.owner || !repo.name) {
		throw new Error("repos[0] must have a non-empty owner and name");
	}
	if (!repo.repoDir) {
		throw new Error("repos[0].repoDir is required");
	}
	if (!repo.baseBranch) {
		throw new Error("repos[0].baseBranch is required");
	}

	const labels = factoryConfig.labels;
	const labelValues = [
		labels.triage,
		labels.fullRun,
		labels.specApproved,
		labels.prReview,
	];
	const labelSet = new Set(labelValues);
	if (labelSet.size !== labelValues.length) {
		throw new Error("All label names in factoryConfig.labels must be distinct");
	}

	if (!factoryConfig.commandPrefix.startsWith("/")) {
		throw new Error("commandPrefix must start with /");
	}

	const runner = factoryConfig.agents.runner;
	const models = factoryConfig.agents.models[runner];
	if (!models) {
		throw new Error(`No models configured for the default runner "${runner}"`);
	}
	for (const tier of ["small", "medium", "large"] as const) {
		if (!models[tier]) {
			throw new Error(`Missing model for tier "${tier}" on runner "${runner}"`);
		}
	}

	if (repo.verify.length === 0) {
		console.warn(
			"Warning: repos[0].verify is empty — no verification commands will run",
		);
	}

	if (repo.preview) {
		if (!repo.preview.serviceName) {
			throw new Error(
				"repos[0].preview.serviceName is required when preview is configured",
			);
		}
	}

	const sandbox = factoryConfig.sandbox;
	if (sandbox.timeoutSeconds > 86_400) {
		throw new Error("sandbox.timeoutSeconds must be at most 86400 (24 hours)");
	}
	if (sandbox.builderTimeoutSeconds !== undefined) {
		if (sandbox.builderTimeoutSeconds > 86_400) {
			throw new Error(
				"sandbox.builderTimeoutSeconds must be at most 86400 (24 hours)",
			);
		}
	}
	if (sandbox.network && sandbox.network.default === "allow-list") {
		const domains = (sandbox.network as { allowedDomains: string[] })
			.allowedDomains;
		if (!domains || domains.length === 0) {
			throw new Error(
				"sandbox.network: allow-list requires at least one domain in allowedDomains",
			);
		}
	}

	const known = knownSpecialistNames();
	for (const name of factoryConfig.review.specialists) {
		if (!known.includes(name)) {
			throw new Error(
				`Unknown specialist "${name}" in review.specialists. Known: ${known.join(", ")}`,
			);
		}
	}
}
