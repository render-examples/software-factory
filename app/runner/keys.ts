import { readFileSync, rmSync } from "node:fs";

/** Each provider's key env vars, first one preferred. Every one of them is removed before tools run. */
export const PROVIDER_KEY_ENV: Readonly<Record<string, readonly string[]>> = {
	anthropic: ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"],
	"ant-ling": ["ANT_LING_API_KEY"],
	"azure-openai-responses": ["AZURE_OPENAI_API_KEY"],
	cerebras: ["CEREBRAS_API_KEY"],
	"cloudflare-ai-gateway": ["CLOUDFLARE_API_KEY"],
	"cloudflare-workers-ai": ["CLOUDFLARE_API_KEY"],
	deepseek: ["DEEPSEEK_API_KEY"],
	fireworks: ["FIREWORKS_API_KEY"],
	"github-copilot": ["COPILOT_GITHUB_TOKEN"],
	google: ["GEMINI_API_KEY"],
	"google-vertex": ["GOOGLE_CLOUD_API_KEY"],
	groq: ["GROQ_API_KEY"],
	huggingface: ["HF_TOKEN"],
	"kimi-coding": ["KIMI_API_KEY"],
	minimax: ["MINIMAX_API_KEY"],
	"minimax-cn": ["MINIMAX_CN_API_KEY"],
	mistral: ["MISTRAL_API_KEY"],
	moonshotai: ["MOONSHOT_API_KEY"],
	"moonshotai-cn": ["MOONSHOT_API_KEY"],
	nvidia: ["NVIDIA_API_KEY"],
	openai: ["OPENAI_API_KEY"],
	opencode: ["OPENCODE_API_KEY"],
	"opencode-go": ["OPENCODE_API_KEY"],
	openrouter: ["OPENROUTER_API_KEY"],
	"qwen-token-plan": ["QWEN_TOKEN_PLAN_API_KEY"],
	"qwen-token-plan-cn": ["QWEN_TOKEN_PLAN_CN_API_KEY"],
	radius: ["RADIUS_API_KEY"],
	together: ["TOGETHER_API_KEY"],
	"vercel-ai-gateway": ["AI_GATEWAY_API_KEY"],
	xai: ["XAI_API_KEY"],
	xiaomi: ["XIAOMI_API_KEY"],
	"xiaomi-token-plan-ams": ["XIAOMI_TOKEN_PLAN_AMS_API_KEY"],
	"xiaomi-token-plan-cn": ["XIAOMI_TOKEN_PLAN_CN_API_KEY"],
	"xiaomi-token-plan-sgp": ["XIAOMI_TOKEN_PLAN_SGP_API_KEY"],
	zai: ["ZAI_API_KEY"],
	"zai-coding-cn": ["ZAI_CODING_CN_API_KEY"],
};

const ALL_PROVIDER_KEY_ENV: readonly string[] = [...new Set(Object.values(PROVIDER_KEY_ENV).flat())];

/** The selected provider's own (first) key var, never another provider's. */
export function providerApiKey(provider: string, env: Readonly<Record<string, string | undefined>>): string | undefined {
	const name = PROVIDER_KEY_ENV[provider]?.[0];
	return (name && env[name]?.trim()) || undefined;
}

export interface Credentials {
	/** From `--key-file` or `--key-stdin`. */
	key?: string;
	/** Provider key vars that were set in `env` before they were removed (local dev without a key file). */
	envKeys: Record<string, string>;
}

/**
 * Reads the key file and removes every trace of model credentials from the filesystem and `env`, so none
 * reach the agent's tool subprocesses. The key file is deleted even if reading it fails. Every provider's
 * vars are removed, not just the selected one: ANTHROPIC_OAUTH_TOKEN, for one, would take precedence inside Pi.
 */
export function takeCredentials(keyFile: string | undefined, env: NodeJS.ProcessEnv): Credentials {
	const envKeys: Record<string, string> = {};
	let key: string | undefined;
	try {
		if (keyFile) key = readFileSync(keyFile, "utf8").trim() || undefined;
	} finally {
		if (keyFile) rmSync(keyFile, { force: true });
		for (const name of ALL_PROVIDER_KEY_ENV) {
			const value = env[name];
			if (value) envKeys[name] = value;
			delete env[name];
		}
	}
	return { key, envKeys };
}

/** The passed key wins; otherwise only the selected provider's own key var. */
export const apiKeyFor = (creds: Credentials, provider: string): string | undefined =>
	creds.key ?? providerApiKey(provider, creds.envKeys);

export const secretsIn = (creds: Credentials): string[] =>
	[creds.key, ...Object.values(creds.envKeys)].filter((s): s is string => !!s);
