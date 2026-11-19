export interface RepoConfig {
	baseBranch: string;
	install?: string;
	verify: string[];
	egress?: string[] | "allow-all";
}

export interface FactoryConfig {
	repos: Record<string, RepoConfig>;
	labels: { triage: string; specApproved: string; prReview: string; autopilot: string };
	commandPrefix: string;
	minimumPermission: "triage" | "write" | "maintain" | "admin";
	limits: {
		repairRounds: number;
		maxChangedFiles: number;
		maxFileBytes: number;
	};
	sandbox: {
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
			egress: ["registry.npmjs.org"],
		},
	},
	labels: {
		triage: "factory:triage",
		specApproved: "factory:spec-approved",
		prReview: "factory:pr-review",
		autopilot: "factory:autopilot",
	},
	commandPrefix: "/factory",
	minimumPermission: "write",
	limits: {
		repairRounds: 2,
		maxChangedFiles: 200,
		maxFileBytes: 1_000_000,
	},
	sandbox: {
		timeoutSeconds: 4 * 60 * 60,
	},
});
