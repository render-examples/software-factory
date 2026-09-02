/**
 * Factory configuration — the knobs you change when pointing this at a repo.
 *
 * Everything else in this codebase is wiring. Start here.
 */

export type ModelTier = "small" | "medium" | "large";

export interface FactoryConfig {
	/** GitHub logins allowed to start a run by applying the trigger label. */
	actors: string[];

	/** Where the repository is checked out inside the sandbox. */
	repoDir: string;

	/**
	 * Commands run in the sandbox after each implementation round. On failure
	 * the output goes back to the implementer to fix. Empty skips verification.
	 */
	verify: string[];

	/** Concrete model per size tier. Agents declare a tier, never a model. */
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
