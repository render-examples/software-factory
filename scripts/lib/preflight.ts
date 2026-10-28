import { z } from "zod";
import type { RepoConfig } from "../../app/config/index.js";
import { GitHubApp, type ScriptDeps, splitRepo } from "./github.js";
import type { Reporter } from "./output.js";
import { checkRepositoryPrerequisites } from "./repo-prerequisites.js";
import { ENV_GROUPS, HARNESS_KEY_ENV, SECRET_ENV } from "./requirements.js";
import { setupRender } from "./setup-render.js";

export interface PreflightOptions extends ScriptDeps {
	repos: Readonly<Record<string, RepoConfig>>;
	nodeVersion: string;
	requiredNodeMajor: number;
	local?: boolean;
	renderApiUrl?: string;
}

const ownerSchema = z.object({ id: z.string().min(1), name: z.string().min(1) });

/** Check every target before provisioning any environment group. */
export async function setupRenderWithPreflight(opts: PreflightOptions, out: Reporter): Promise<number> {
	const code = await runPreflight({ ...opts, local: false }, out);
	return code === 0 ? setupRender(opts, out) : code;
}

/** No configuration writes, model calls, or Sandbox creation; installation tokens are read-only and repository-scoped. */
export async function runPreflight(opts: PreflightOptions, out: Reporter): Promise<number> {
	out.addSecrets(...[...SECRET_ENV, ...HARNESS_KEY_ENV].map((name) => opts.env[name]));
	out.heading("Setup prerequisites");
	const major = /^v?(\d+)\./.exec(opts.nodeVersion)?.[1];
	if (Number(major) !== opts.requiredNodeMajor) {
		out.fail(`Node ${opts.requiredNodeMajor} is required by .node-version`, `Activate the pinned Node version; currently ${opts.nodeVersion}`);
	} else out.pass(`Node ${opts.requiredNodeMajor} matches .node-version`);
	if (opts.local) return out.summary();

	for (const key of new Set(ENV_GROUPS.flatMap((group) => group.keys))) {
		if (!opts.env[key]?.trim()) out.fail(`${key} is not set`, "Complete App installation and local secret entry before deployment preflight");
	}
	const workspace = opts.env.RENDER_WORKSPACE_ID?.trim();
	if (workspace && !/^tea-[a-z0-9]+$/.test(workspace))
		out.fail("RENDER_WORKSPACE_ID is not a workspace ID", "Use the tea-… ID from Workspace Settings");
	if (!Object.keys(opts.repos).length) out.fail("No target repositories configured", "Configure repos in factory.config.ts");
	for (const [fullName, repo] of Object.entries(opts.repos)) {
		if (!repo.baseBranch.trim()) out.fail(`${fullName}: baseBranch is empty`, "Set an existing baseBranch in factory.config.ts");
	}
	if (out.count("fail")) return out.summary();

	try {
		const response = await (opts.fetch ?? fetch)(
			`${opts.renderApiUrl ?? "https://api.render.com"}/v1/owners/${encodeURIComponent(workspace ?? "")}`,
			{
				headers: { Authorization: `Bearer ${opts.env.RENDER_API_KEY?.trim()}`, Accept: "application/json" },
				signal: AbortSignal.timeout(15_000),
			},
		);
		if (response.status === 401 || response.status === 403)
			out.fail("RENDER_API_KEY was rejected", "Use a key with access to the selected workspace");
		else if (!response.ok)
			out.fail(`Render workspace access is unverified (HTTP ${response.status})`, "Check RENDER_WORKSPACE_ID and account access");
		else {
			const owner = ownerSchema.safeParse(await response.json().catch(() => null));
			if (!owner.success || owner.data.id !== workspace) out.fail("Render workspace metadata is invalid; access is unverified", "Retry preflight");
			else out.pass(`Render key can access workspace ${owner.data.name} (${workspace})`);
		}
	} catch {
		out.fail("Render workspace access could not be verified", "Check connectivity and retry preflight");
	}

	let app: GitHubApp | undefined;
	try {
		app = new GitHubApp(opts);
		for (const [fullName, repoConfig] of Object.entries(opts.repos)) {
			try {
				const { owner, name } = splitRepo(fullName);
				const installation = await app.repoInstallation(owner, name);
				if (!installation) {
					out.fail(`${fullName}: GitHub App is not installed`, "Install the App on this repository before deployment");
					continue;
				}
				const token = await app.installationToken(installation.id, name, { contents: "read", metadata: "read" });
				out.addSecrets(token);
				await checkRepositoryPrerequisites(app.repo(owner, name, token), fullName, repoConfig.baseBranch, out);
			} catch {
				out.addSecrets(...app.mintedTokens);
				out.fail(`${fullName}: GitHub access could not be verified`, "Check App credentials, installation, and Contents read access");
			}
		}
	} catch {
		out.fail("GitHub App credentials could not be verified", "Complete setup:app and check GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY");
	}
	out.warn(
		"Model and Sandbox execution remain unverified",
		"Confirm Sandboxes access in Oregon and configured-model access; the approved Triage smoke test verifies execution",
	);
	out.line("Key presence does not verify model access or provider spend caps. Preflight creates no Sandbox and makes no model request.");
	return out.summary();
}
