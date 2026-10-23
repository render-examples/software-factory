/** Each supported provider's key env vars, first one preferred. Every one of them is removed before tools run. */
export const PROVIDER_KEY_ENV: Readonly<Record<string, readonly string[]>> = {
	anthropic: ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"],
	google: ["GEMINI_API_KEY"],
	openai: ["OPENAI_API_KEY"],
};

const ALL_PROVIDER_KEY_ENV: readonly string[] = [...new Set(Object.values(PROVIDER_KEY_ENV).flat())];

/** The selected provider's own (first) key var, never another provider's. The host reads the key it sends with this. */
export function providerApiKey(provider: string, env: Readonly<Record<string, string | undefined>>): string | undefined {
	const name = PROVIDER_KEY_ENV[provider]?.[0];
	return (name && env[name]?.trim()) || undefined;
}

/**
 * Removes every provider's key vars from `env`, so none reach the agent's tool subprocesses, and returns their
 * values for redaction. Every provider's vars go, not just the selected one: ANTHROPIC_OAUTH_TOKEN, for one, would
 * take precedence inside Pi. The runner's only key is the one on stdin.
 */
export function scrubProviderKeys(env: NodeJS.ProcessEnv): string[] {
	const removed: string[] = [];
	for (const name of ALL_PROVIDER_KEY_ENV) {
		const value = env[name];
		if (value) removed.push(value);
		delete env[name];
	}
	return removed;
}
