/**
 * Key env vars of every provider a built-in harness can call. Every one of them, plus each bundled harness's own
 * key var, is removed before tools run: ANTHROPIC_OAUTH_TOKEN, for one, would take precedence inside Pi.
 */
export const KNOWN_KEY_ENV: readonly string[] = [
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_OAUTH_TOKEN",
	"ANTHROPIC_AUTH_TOKEN",
	"GEMINI_API_KEY",
	"OPENAI_API_KEY",
	"CURSOR_API_KEY",
];

/**
 * Removes every key var in KNOWN_KEY_ENV and `extra` from `env`, so none reach the agent's tool subprocesses, and
 * returns their values for redaction. The runner's only key is the one on stdin.
 */
export function scrubKeys(env: NodeJS.ProcessEnv, extra: readonly string[] = []): string[] {
	const removed: string[] = [];
	for (const name of new Set([...KNOWN_KEY_ENV, ...extra])) {
		const value = env[name];
		if (value) removed.push(value);
		delete env[name];
	}
	return removed;
}
