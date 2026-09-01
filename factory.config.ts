/**
 * Factory configuration.
 *
 * `verify` — commands the workflow runs deterministically after each
 * implementation round.  Results are fed back to the implementer on failure.
 * When empty, the workflow skips verification and proceeds to review.
 *
 * `models` — maps abstract size tiers to concrete model identifiers.
 * Agents declare `small`, `medium`, or `large`; the factory resolves them
 * here.  Omit a tier to use the SDK default for that size.
 */
export const factoryConfig = {
	verify: ["npm run build", "npx vitest run"],
	models: {
		small: "claude-haiku-4-5",
		medium: "claude-sonnet-5",
		large: "claude-opus-5",
	},
};
