export type ModelTier = "small" | "medium" | "large";

export interface RepoConfig {
	/** Branch that specs are implemented against and snapshots are built from. */
	baseBranch: string;
	/** Installs dependencies in the sandbox. Runs after credentials are removed. */
	install?: string;
	/** Commands that must pass before a PR opens and that PR Reviewer runs. */
	verify: string[];
}

export interface FactoryConfig {
	/** Repositories the factory acts on, keyed by "owner/name". Webhooks from any other repository are ignored. */
	repos: Record<string, RepoConfig>;
	labels: { triage: string; specApproved: string; prReview: string };
	/** Prefix for comment commands, such as `/factory cancel`. */
	commandPrefix: string;
	/** GitHub permission the triggering actor needs on the repository. */
	minimumPermission: "triage" | "write" | "maintain" | "admin";
	/** "provider/model" per tier, from Pi's model registry. */
	models: Record<ModelTier, string>;
	limits: {
		/** Fix rounds after a failed verify in Spec-to-PR. */
		repairRounds: number;
		/** Publishing refuses a change with more files than this. */
		maxChangedFiles: number;
		/** Publishing refuses any changed file larger than this. */
		maxFileBytes: number;
	};
	sandbox: {
		/** Render terminates a sandbox after this, even if the task that opened it crashed. */
		timeoutSeconds: number;
	};
}

export function defineFactoryConfig(config: FactoryConfig): FactoryConfig {
	return config;
}

export default defineFactoryConfig({
	repos: {
		"render-examples/render-factory-example-target": {
			baseBranch: "main",
			install: "npm ci",
			verify: ["npm run build", "npm test"],
		},
	},
	labels: {
		triage: "factory:triage",
		specApproved: "factory:spec-approved",
		prReview: "factory:pr-review",
	},
	commandPrefix: "/factory",
	minimumPermission: "write",
	models: {
		small: "anthropic/claude-haiku-4-5",
		medium: "anthropic/claude-sonnet-5",
		large: "anthropic/claude-opus-5",
	},
	limits: {
		repairRounds: 2,
		maxChangedFiles: 200,
		maxFileBytes: 1_000_000,
	},
	sandbox: {
		timeoutSeconds: 4 * 60 * 60,
	},
});
