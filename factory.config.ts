/** The knobs you change when pointing this factory at a repository. */

export type ModelTier = "small" | "medium" | "large";

export interface FactoryConfig {
	actors: string[];
	repoDir: string;
	verify: string[];
	models: Record<ModelTier, string>;
}

export const factoryConfig: FactoryConfig = {
	actors: ["jacobprall", "R4ph-t"],
	repoDir: "/home/user/repo",
	verify: ["npm run build", "npx vitest run"],
	models: {
		small: "claude-haiku-4-5",
		medium: "claude-sonnet-5",
		large: "claude-opus-5",
	},
};
