export const KNOWN_KEY_ENV: readonly string[] = [
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_OAUTH_TOKEN",
	"ANTHROPIC_AUTH_TOKEN",
	"GEMINI_API_KEY",
	"OPENAI_API_KEY",
];

export function scrubKeys(env: NodeJS.ProcessEnv, extra: readonly string[] = []): string[] {
	const removed: string[] = [];
	for (const name of new Set([...KNOWN_KEY_ENV, ...extra])) {
		const value = env[name];
		if (value) removed.push(value);
		delete env[name];
	}
	return removed;
}
