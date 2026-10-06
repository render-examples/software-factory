/** The knobs you change when pointing this factory at a repository. */

export type ModelTier = "small" | "medium" | "large";
export type RunnerName = "claude" | "openai";

export interface RepoTarget {
	owner: string;
	name: string;
	baseBranch: string;
	repoDir: string;
	setup: { install: string; browsers?: boolean };
	verify: string[];
	dev?: {
		start: string;
		port: number;
		healthPath: string;
		readyTimeoutSeconds?: number;
		env?: Record<string, string>;
	};
	preview?: { serviceName: string };
	allowWorkflowChanges?: boolean;
}

export interface FactoryLabels {
	triage: string;
	fullRun: string;
	specApproved: string;
	prReview: string;
}

export type SandboxNetworkPolicy =
	| { default: "allow-all" }
	| { default: "deny-all" }
	| { default: "allow-list"; allowedDomains: string[] };

export interface FactoryConfig {
	repos: [RepoTarget, ...RepoTarget[]];
	labels: FactoryLabels;
	commandPrefix: string;
	minimumPermission: string;
	agents: {
		runner: RunnerName;
		models: Partial<Record<RunnerName, Record<ModelTier, string>>>;
	};
	review: { specialists: string[] };
	sandbox: {
		timeoutSeconds: number;
		/** Builder sandbox timeout in seconds. Default 7200. Max 86400. */
		builderTimeoutSeconds?: number;
		/**
		 * Render native sandbox network policy for run sandboxes.
		 * Omit to use the platform default.
		 * Sandboxes need egress to github.com (fetch), the package registry
		 * used by setup.install (lockfile-change reinstall), and the preview
		 * domain (preview UX testing).
		 */
		network?: SandboxNetworkPolicy;
	};
	limits: {
		repairRounds: number;
		perRunUsd: number;
		toolOutputChars: number;
		artifactBytes: number;
		runArtifactBytes: number;
	};
	pricing: Record<
		string,
		{
			inputPerMTok: number;
			outputPerMTok: number;
			cacheReadPerMTok?: number;
			cacheWritePerMTok?: number;
		}
	>;
}

export function defineFactoryConfig(config: FactoryConfig): FactoryConfig {
	return config;
}

export const factoryConfig = defineFactoryConfig({
	repos: [
		{
			owner: "jacobprall",
			name: "render-factory-sample",
			baseBranch: "main",
			repoDir: "/home/user/repo",
			setup: { install: "npm ci", browsers: true },
			verify: ["npm run build", "npm test"],
			dev: {
				start: "npm run dev -- --port 3000",
				port: 3000,
				healthPath: "/",
			},
			preview: { serviceName: "sample-web" },
		},
	],
	labels: {
		triage: "factory:triage",
		fullRun: "factory:full-run",
		specApproved: "factory:spec-approved",
		prReview: "factory:pr-review",
	},
	commandPrefix: "/factory",
	minimumPermission: "write",
	agents: {
		runner: "claude",
		models: {
			claude: {
				small: "claude-haiku-4-5",
				medium: "claude-sonnet-5",
				large: "claude-opus-5",
			},
		},
	},
	review: { specialists: ["security", "correctness", "performance", "tests"] },
	sandbox: {
		timeoutSeconds: 7_200,
		builderTimeoutSeconds: 7_200,
		network: undefined,
	},
	limits: {
		repairRounds: 2,
		perRunUsd: 20,
		toolOutputChars: 40_000,
		artifactBytes: 5_000_000,
		runArtifactBytes: 50_000_000,
	},
	pricing: {},
});
