/**
 * Factory configuration for the target repository.
 *
 * `verify` — commands the workflow runs deterministically after each
 * implementation round.  Results are fed back to the implementer on failure.
 * When empty, the workflow skips verification and proceeds to review.
 */
export const factoryConfig = {
	verify: [] as readonly string[],
};
