import {
	type FactoryConfig,
	type ModelTier,
	type RunnerName,
	factoryConfig,
} from "../../factory.config.js";

export interface Repository {
	owner: string;
	repo: string;
	fullName: string;
}

export function requireEnv(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is not set`);
	return value;
}

/** The single target repository, derived from config rather than an env var. */
export function repository(): Repository {
	const target = factoryConfig.repos[0];
	return {
		owner: target.owner,
		repo: target.name,
		fullName: `${target.owner}/${target.name}`,
	};
}

/** The target repo configuration object. */
export function target(): FactoryConfig["repos"][0] {
	return factoryConfig.repos[0];
}

/** Resolve a model ID for a tier on the active (or specified) runner. */
export function modelFor(tier: ModelTier, runner?: RunnerName): string {
	const r = runner ?? factoryConfig.agents.runner;
	const models = factoryConfig.agents.models[r];
	if (!models) throw new Error(`No models configured for runner "${r}"`);
	return models[tier];
}

/** The label that starts a full pipeline run. */
export function triggerLabel(): string {
	return factoryConfig.labels.fullRun;
}

/** FACTORY_GITHUB_ACTORS overrides the checked-in list in factory.config.ts. */
export function allowedActors(): Set<string> {
	const override = process.env.FACTORY_GITHUB_ACTORS?.trim();
	const raw = override ? override.split(",") : factoryConfig.actors;
	const actors = new Set(
		raw.map((actor) => actor.trim().toLowerCase()).filter(Boolean),
	);
	if (actors.size === 0) {
		throw new Error(
			"No allowed actors. Set FACTORY_GITHUB_ACTORS or add actors to factory.config.ts",
		);
	}
	return actors;
}
