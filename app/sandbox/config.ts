export interface SandboxConfig {
	apiKey: string;
	workspaceId: `tea-${string}`;
	/** Client-side pacing for the Sandbox API's limit of 100 requests a minute per workspace. */
	minRequestIntervalMs: number;
}

/** Reads RENDER_API_KEY, and RENDER_WORKSPACE_ID when set (otherwise resolved from the key). */
export async function loadSandboxConfig(
	env: NodeJS.ProcessEnv = process.env,
	fetcher: typeof fetch = fetch,
): Promise<SandboxConfig> {
	const apiKey = env.RENDER_API_KEY?.trim();
	if (!apiKey) throw new Error("RENDER_API_KEY is required for Render sandboxes");
	const explicit = env.RENDER_WORKSPACE_ID?.trim();
	if (explicit && !explicit.startsWith("tea-")) throw new Error("RENDER_WORKSPACE_ID must be a tea-… workspace id");
	const interval = env.RENDER_API_MIN_INTERVAL_MS?.trim();
	const minRequestIntervalMs = interval ? Number(interval) : 1_000;
	if (!Number.isInteger(minRequestIntervalMs) || minRequestIntervalMs < 0) {
		throw new Error("RENDER_API_MIN_INTERVAL_MS must be a non-negative integer");
	}
	return {
		apiKey,
		workspaceId: explicit ? (explicit as `tea-${string}`) : await resolveWorkspaceId(apiKey, fetcher),
		minRequestIntervalMs,
	};
}

interface Owner {
	id: string;
	name: string;
	type: string;
}

/**
 * Resolves the workspace from the API key when RENDER_WORKSPACE_ID is not set: exactly one workspace is used;
 * several or none fail with a message saying what to set.
 *
 * API: GET /v1/owners — https://api-docs.render.com/reference/list-owners
 */
export async function resolveWorkspaceId(apiKey: string, fetcher: typeof fetch = fetch): Promise<`tea-${string}`> {
	const owners: Owner[] = [];
	for (let cursor: string | undefined; ; ) {
		const params = new URLSearchParams({ limit: "100" });
		if (cursor) params.set("cursor", cursor);
		const res = await fetcher(`https://api.render.com/v1/owners?${params}`, {
			headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
			signal: AbortSignal.timeout(15_000),
		});
		if (!res.ok) throw new Error(`Render API /v1/owners failed: ${res.status}`);
		const page = (await res.json()) as { owner: Owner; cursor: string }[];
		owners.push(...page.map((item) => item.owner));
		cursor = page.at(-1)?.cursor;
		if (page.length < 100 || !cursor) break;
	}
	const [only, ...rest] = owners;
	if (!only) throw new Error("RENDER_API_KEY has no workspaces; check the key");
	if (rest.length > 0) {
		const list = owners.map((o) => `  ${o.id} (${o.name}, ${o.type})`).join("\n");
		throw new Error(`RENDER_WORKSPACE_ID is required: the API key has access to multiple workspaces:\n${list}`);
	}
	return only.id as `tea-${string}`;
}
