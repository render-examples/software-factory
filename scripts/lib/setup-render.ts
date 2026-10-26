/**
 * setup:render: create or update the environment groups render.yaml links, from local values. Idempotent.
 * It writes only the keys in ENV_GROUPS and leaves other variables in a group alone.
 */
import type { Env, ScriptDeps } from "./github.js";
import { errorMessage, type Reporter } from "./output.js";
import { ENV_GROUPS, type EnvGroupSpec } from "./requirements.js";

/** Values safe to show; every other group value is redacted from output. */
const NOT_SECRET = new Set(["RENDER_WORKSPACE_ID", "GITHUB_APP_ID"]);

export interface SetupRenderOptions extends ScriptDeps {
	renderApiUrl?: string;
}

interface EnvGroup {
	id: string;
	name: string;
	ownerId: string;
	envVars?: { key: string; value: string }[];
}

class RenderApi {
	private readonly base: string;

	constructor(
		private readonly apiKey: string,
		private readonly deps: SetupRenderOptions,
	) {
		this.base = `${(deps.renderApiUrl ?? "https://api.render.com").replace(/\/+$/, "")}/v1`;
	}

	async request<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
		const response = await (this.deps.fetch ?? fetch)(`${this.base}${path}`, {
			method,
			headers: {
				Authorization: `Bearer ${this.apiKey}`,
				Accept: "application/json",
				...(body === undefined ? {} : { "Content-Type": "application/json" }),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(15_000),
		});
		const data = (await response.json().catch(() => undefined)) as T;
		return { status: response.status, data };
	}

	async expect<T>(method: string, path: string, body?: unknown): Promise<T> {
		const { status, data } = await this.request<T>(method, path, body);
		if (status < 200 || status >= 300) {
			const message = (data as { message?: string } | undefined)?.message;
			throw new Error(`${method} ${path.split("?")[0]} returned ${status}${message ? `: ${message}` : ""}`);
		}
		return data;
	}
}

export async function setupRender(opts: SetupRenderOptions, out: Reporter): Promise<number> {
	const { env } = opts;
	for (const group of ENV_GROUPS) out.addSecrets(...group.keys.filter((key) => !NOT_SECRET.has(key)).map((key) => env[key]));

	out.heading("Values from .env");
	let missing = false;
	for (const group of ENV_GROUPS) {
		for (const key of group.keys) {
			if (env[key]?.trim()) continue;
			missing = true;
			out.fail(`${key} is not set`, `Add it to .env; it goes in the ${group.name} env group`);
		}
	}
	const workspace = env.RENDER_WORKSPACE_ID?.trim();
	if (workspace && !workspace.startsWith("tea-")) {
		missing = true;
		out.fail("RENDER_WORKSPACE_ID is not a workspace ID", "It looks like tea-…; find it in Workspace Settings");
	}
	// Writing nothing until every value is present keeps a half-filled group from reaching a deploy.
	if (missing || !workspace) return out.summary();
	out.pass(`all ${ENV_GROUPS.reduce((n, group) => n + group.keys.length, 0)} values are set`);

	const api = new RenderApi(env.RENDER_API_KEY?.trim() ?? "", opts);
	out.heading(`Render workspace ${workspace}`);
	const owner = await api.request<{ name?: string }>("GET", `/owners/${encodeURIComponent(workspace)}`);
	if (owner.status === 401 || owner.status === 403) {
		out.fail(`RENDER_API_KEY was rejected by the Render API (${owner.status})`, "Create a key in Account Settings > API Keys");
		return out.summary();
	}
	if (owner.status === 404) {
		out.fail(`workspace ${workspace} was not found`, "Check RENDER_WORKSPACE_ID and that the API key's user belongs to the workspace");
		return out.summary();
	}
	if (owner.status < 200 || owner.status >= 300) {
		out.fail(`the Render API returned ${owner.status} for the workspace`);
		return out.summary();
	}
	out.pass(`RENDER_API_KEY can access ${owner.data?.name ?? workspace}`);

	for (const group of ENV_GROUPS) {
		try {
			await syncGroup(api, group, workspace, env, out);
		} catch (error) {
			out.fail(`could not set up ${group.name}: ${errorMessage(error)}`);
		}
	}
	return out.summary();
}

async function syncGroup(api: RenderApi, spec: EnvGroupSpec, workspace: string, env: Env, out: Reporter): Promise<void> {
	out.heading(`Env group ${spec.name} (${spec.services.map((s) => `factory-${s}`).join(", ")})`);
	const query = new URLSearchParams({ name: spec.name, ownerId: workspace, limit: "100" });
	const listed = await api.expect<{ envGroup: EnvGroup }[]>("GET", `/env-groups?${query}`);
	// Blueprints link groups by name, so a second group with the same name makes the link ambiguous.
	const matches = (listed ?? []).map((item) => item.envGroup).filter((group) => group.name === spec.name && group.ownerId === workspace);
	if (matches.length > 1) {
		out.fail(`${matches.length} env groups are named ${spec.name}`, "Delete or rename the extra groups in the Render Dashboard");
		return;
	}

	const values = Object.fromEntries(spec.keys.map((key) => [key, env[key]?.trim() ?? ""]));
	const existing = matches[0];
	if (!existing) {
		await api.expect("POST", "/env-groups", {
			name: spec.name,
			ownerId: workspace,
			envVars: spec.keys.map((key) => ({ key, value: values[key] })),
		});
		out.pass(`created with ${spec.keys.join(", ")}`);
		return;
	}

	const current = await api.expect<EnvGroup>("GET", `/env-groups/${encodeURIComponent(existing.id)}`);
	const stored = new Map((current.envVars ?? []).map((v) => [v.key, v.value]));
	for (const key of spec.keys) {
		if (stored.get(key) === values[key]) {
			out.pass(`${key} unchanged`);
			continue;
		}
		await api.expect("PUT", `/env-groups/${encodeURIComponent(existing.id)}/env-vars/${encodeURIComponent(key)}`, { value: values[key] });
		out.pass(`${key} ${stored.has(key) ? "updated" : "added"}`);
	}
}
