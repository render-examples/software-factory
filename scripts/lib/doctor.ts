/** doctor: read-only checks of one or both services' environment, the GitHub App, and Workflows tasks. */
import type { Agent } from "../../app/agents/define.js";
import { AGENTS } from "../../app/agents/registry.js";
import { TASKS } from "../../app/config/index.js";
import { appCredentialsFrom, type Env, GitHubApp, type ScriptDeps, splitRepo } from "./github.js";
import { PLACEHOLDER_WEBHOOK_URL } from "./manifest.js";
import { errorMessage, type Reporter } from "./output.js";
import { envGroupFor, LABELS, missingEvents, missingPermissions, SECRET_ENV, SERVICE_ENV, type Service, WEBHOOK_PATH } from "./requirements.js";
import { appSettingsUrl } from "./setup-github.js";

export interface DoctorOptions extends ScriptDeps {
	services: readonly Service[];
	repos: readonly string[];
	/** The agents whose harnesses to check; defaults to every agent the factory runs. */
	agents?: readonly Agent[];
	renderApiUrl?: string;
}

export async function runDoctor(opts: DoctorOptions, out: Reporter): Promise<number> {
	const { env } = opts;
	const agents = opts.agents ?? AGENTS;
	out.addSecrets(...SECRET_ENV.map((name) => env[name]), ...agents.map((agent) => env[agent.harness.credential]));

	checkEnv(opts, out);
	if (opts.services.includes("workflows")) checkHarnesses(env, agents, out);
	await checkGitHub(opts, out);
	await checkTasks(opts, out);
	return out.summary();
}

function checkEnv({ env, services }: DoctorOptions, out: Reporter): void {
	for (const service of services) {
		out.heading(`Environment: factory-${service}`);
		for (const name of SERVICE_ENV[service]) {
			if (env[name]?.trim()) out.pass(`${name} is set`);
			else out.fail(`${name} is not set`, setFix(service, name));
		}
		const workspace = env.RENDER_WORKSPACE_ID?.trim();
		if (service === "workflows" && workspace && !workspace.startsWith("tea-")) {
			out.fail("RENDER_WORKSPACE_ID is not a workspace ID", "It looks like tea-…; find it in Workspace Settings");
		}
	}
}

function setFix(service: Service, name: string): string {
	const group = envGroupFor(service, name);
	if (!group) return `Set it on factory-${service} (render.yaml declares it)`;
	return `Set it in the ${group.name} env group: add it to .env and run \`npm run setup:render\``;
}

/** Each harness the agents use, the agents on it, and whether its key is set. */
function checkHarnesses(env: Env, agents: readonly Agent[], out: Reporter): void {
	out.heading("Agent harnesses");
	const groups = new Map<string, { agent: Agent; ids: string[] }>();
	for (const agent of agents) {
		const key = `${agent.harness.name} ${agent.harness.label}`;
		const group = groups.get(key) ?? { agent, ids: [] };
		group.ids.push(agent.id);
		groups.set(key, group);
	}
	for (const [label, { agent, ids }] of groups) {
		const { credential } = agent.harness;
		if (env[credential]?.trim()) out.pass(`${label} (${ids.join(", ")}): ${credential} is set`);
		else out.fail(`${label} (${ids.join(", ")}): ${credential} is not set`, `${setFix("workflows", credential)}; use a spend-capped key`);
	}
}

async function checkGitHub(opts: DoctorOptions, out: Reporter): Promise<void> {
	const { env } = opts;
	out.heading("GitHub App");
	const hasCredentials = !!(env.GITHUB_APP_ID?.trim() && env.GITHUB_APP_PRIVATE_KEY?.trim());
	if (!hasCredentials) {
		out.skip(
			"GitHub checks: no App credentials here",
			opts.services.includes("workflows")
				? "Set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY"
				: "The gateway doesn't hold them; run `npm run doctor -- --service workflows` where they're set",
		);
		return;
	}
	try {
		appCredentialsFrom(env);
		out.pass("GITHUB_APP_PRIVATE_KEY parses");
	} catch (error) {
		out.fail(errorMessage(error));
		return;
	}

	const app = new GitHubApp(opts);
	let info: Awaited<ReturnType<GitHubApp["getApp"]>>;
	try {
		info = await app.getApp();
		out.pass(`App JWT works: ${info.slug} (id ${info.id})`);
	} catch (error) {
		out.fail(`App JWT rejected: ${errorMessage(error)}`, "Check that GITHUB_APP_ID belongs to GITHUB_APP_PRIVATE_KEY");
		return;
	}
	const perms = missingPermissions(info.permissions);
	if (perms.length) out.fail(`App lacks permissions: ${perms.join(", ")}`, `Add them in ${appSettingsUrl(info, app.apiUrl)}`);
	else out.pass("App permissions cover contents, issues, pull_requests (write) and metadata (read)");
	const events = missingEvents(info.events);
	if (events.length) out.fail(`App isn't subscribed to: ${events.join(", ")}`, `Subscribe in ${appSettingsUrl(info, app.apiUrl)}`);
	else out.pass("App subscribes to issues, issue_comment, pull_request, push");

	await checkWebhook(app, info, env, out);
	for (const fullName of opts.repos) await checkRepo(app, info, fullName, out);
	out.addSecrets(...app.mintedTokens);
}

async function checkWebhook(app: GitHubApp, info: Awaited<ReturnType<GitHubApp["getApp"]>>, env: Env, out: Reporter) {
	const settings = appSettingsUrl(info, app.apiUrl);
	try {
		const hook = await app.getHookConfig();
		const url = hook.url ? safeUrl(hook.url) : null;
		if (!url || hook.url === PLACEHOLDER_WEBHOOK_URL) {
			out.fail("webhook URL is not set to the gateway", "Run `npm run setup:github -- --gateway-url <gateway URL>`");
		} else if (url.protocol !== "https:" || !url.pathname.replace(/\/+$/, "").endsWith(WEBHOOK_PATH)) {
			out.fail(`webhook URL ${hook.url} is not an https …${WEBHOOK_PATH} URL`, "Rerun `npm run setup:github`");
		} else {
			out.pass(`webhook URL is ${hook.url}`);
			const external = env.RENDER_EXTERNAL_URL?.trim();
			if (external && safeUrl(external)?.origin !== url.origin) {
				out.warn(`webhook URL doesn't point at this service (${external})`);
			}
		}
		if (hook.content_type === "json") out.pass("webhook content type is json");
		else out.fail(`webhook content type is ${hook.content_type ?? "unset"}, not json`, "Rerun `npm run setup:github`");
		if (String(hook.insecure_ssl ?? "0") !== "0") out.warn("webhook skips TLS verification", "Set insecure_ssl to 0");
	} catch (error) {
		out.fail(`could not read the webhook config: ${errorMessage(error)}`);
	}

	// GET /app/hook/config doesn't report whether the hook is active; recent deliveries do.
	try {
		const [latest] = await app.recentDeliveries(10);
		if (!latest) {
			out.warn("no webhook deliveries yet, so the hook may be inactive", `Check Webhook > Active in ${settings}`);
		} else if (latest.status_code >= 200 && latest.status_code < 300) {
			out.pass(`webhook is active: latest delivery (${latest.event}, ${latest.delivered_at}) got ${latest.status_code}`);
		} else if (latest.status_code === 401) {
			out.fail(
				"the gateway rejected the latest delivery's signature (401)",
				"The gateway's GITHUB_WEBHOOK_SECRET differs from the App's: rerun setup:github with the gateway's value",
			);
		} else {
			out.warn(`latest webhook delivery (${latest.event}, ${latest.delivered_at}) got ${latest.status_code || "no response"}`);
		}
	} catch (error) {
		out.warn(`could not list webhook deliveries: ${errorMessage(error)}`);
	}
}

async function checkRepo(app: GitHubApp, info: { slug: string; html_url: string }, fullName: string, out: Reporter) {
	out.heading(fullName);
	try {
		const { owner, name } = splitRepo(fullName);
		const installation = await app.repoInstallation(owner, name);
		if (!installation) {
			out.fail(`${info.slug} is not installed on ${fullName}`, `Install it at ${info.html_url}/installations/new`);
			return;
		}
		out.pass(`installed (installation ${installation.id})`);
		const perms = missingPermissions(installation.permissions);
		if (perms.length) {
			out.warn(`installation hasn't granted: ${perms.join(", ")}`, "An owner must accept the App's updated permissions in the installation settings");
		}
		const events = missingEvents(installation.events);
		if (events.length) out.warn(`installation isn't receiving: ${events.join(", ")}`, "Accept the App's updated events");

		const token = await app.installationToken(installation.id, name, { issues: "read", metadata: "read" });
		out.addSecrets(token);
		out.pass("installation token minted");

		const existing = new Set((await app.repo(owner, name, token).listLabels()).map((l) => l.name.toLowerCase()));
		const missing = LABELS.filter((label) => !existing.has(label.name.toLowerCase()));
		for (const label of LABELS.filter((l) => !missing.includes(l))) out.pass(`label ${label.name} exists`);
		for (const label of missing) {
			if (label.trigger) out.fail(`label ${label.name} is missing`, "Run `npm run setup:github`");
			else out.warn(`label ${label.name} is missing (created on first run)`, "Run `npm run setup:github`");
		}
	} catch (error) {
		out.fail(`could not check ${fullName}: ${errorMessage(error)}`);
	}
}

/**
 * The Render API's GET /v1/tasks, filtered by slug, for each task the gateway starts. The SDK's workflows client
 * has no list-tasks method, so this is a plain request. A non-auth API error skips rather than fails.
 */
async function checkTasks(opts: DoctorOptions, out: Reporter): Promise<void> {
	out.heading("Workflows tasks");
	const apiKey = opts.env.RENDER_API_KEY?.trim();
	if (!apiKey) {
		out.skip("task registration: RENDER_API_KEY is not set");
		return;
	}
	const slug = opts.env.RENDER_WORKFLOW_SLUG?.trim() || "factory-workflows";
	const expected = Object.values(TASKS);
	const url = new URL(`${(opts.renderApiUrl ?? "https://api.render.com").replace(/\/+$/, "")}/v1/tasks`);
	for (const task of expected) url.searchParams.append("taskSlug", `${slug}/${task}`);
	url.searchParams.set("limit", "100");
	let response: Response;
	try {
		response = await (opts.fetch ?? fetch)(url, {
			headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
			signal: AbortSignal.timeout(15_000),
		});
	} catch (error) {
		out.skip(`task registration: Render API unreachable (${errorMessage(error)})`);
		return;
	}
	if (response.status === 401 || response.status === 403) {
		out.fail(`RENDER_API_KEY was rejected by the Render API (${response.status})`);
		return;
	}
	if (!response.ok) {
		out.skip(`task registration: the Render API returned ${response.status} for GET /v1/tasks`);
		return;
	}
	const rows = (await response.json().catch(() => [])) as { task?: { name?: string } }[];
	const found = new Set(rows.map((row) => row.task?.name).filter((name): name is string => !!name));
	const missing = expected.filter((task) => !found.has(task));
	if (found.size === 0) {
		out.warn(`no tasks found for workflow ${slug}`, "Deploy factory-workflows; on the gateway, RENDER_WORKFLOW_SLUG must be its slug");
	} else if (missing.length) {
		out.fail(`tasks not registered on ${slug}: ${missing.join(", ")}`, "Redeploy factory-workflows");
	} else {
		out.pass(`${slug} registers ${expected.join(", ")}`);
	}
}

function safeUrl(value: string): URL | null {
	try {
		return new URL(value);
	} catch {
		return null;
	}
}
