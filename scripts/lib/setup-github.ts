/** setup:github: point the App's webhook at the gateway and create the factory's labels. Idempotent. */
import { type AppInfo, type GitHubApp, githubWebUrl, splitRepo } from "./github.js";
import { errorMessage, type Reporter } from "./output.js";
import { LABELS, WEBHOOK_PATH } from "./requirements.js";

/** `<gateway>/webhooks/github` from the gateway's base URL (a pasted full webhook URL is accepted too). */
export function webhookUrl(gatewayUrl: string): string {
	let url: URL;
	try {
		url = new URL(gatewayUrl.trim());
	} catch {
		throw new Error(`--gateway-url is not a URL: ${gatewayUrl}`);
	}
	if (url.protocol !== "https:") throw new Error("--gateway-url must be https (GitHub delivers to public HTTPS URLs)");
	if (url.search || url.hash) throw new Error("--gateway-url must not have a query or fragment");
	let path = url.pathname.replace(/\/+$/, "");
	if (path.endsWith(WEBHOOK_PATH)) path = path.slice(0, -WEBHOOK_PATH.length);
	return `${url.origin}${path}${WEBHOOK_PATH}`;
}

/** The App's settings page, where the webhook's Active box lives. */
export function appSettingsUrl(app: AppInfo, apiUrl: string): string {
	const web = githubWebUrl(apiUrl);
	const slug = encodeURIComponent(app.slug);
	if (app.owner?.type === "Organization") {
		return `${web}/organizations/${encodeURIComponent(app.owner.login)}/settings/apps/${slug}`;
	}
	return `${web}/settings/apps/${slug}`;
}

export interface SetupGithubOptions {
	gatewayUrl: string;
	webhookSecret: string;
	repos: readonly string[];
}

export async function setupGithub(app: GitHubApp, opts: SetupGithubOptions, out: Reporter): Promise<number> {
	out.addSecrets(opts.webhookSecret);
	const url = webhookUrl(opts.gatewayUrl);

	const info = await app.getApp();
	out.heading(`GitHub App ${info.slug} (id ${info.id})`);

	await configureWebhook(app, info, url, opts.webhookSecret, out);
	for (const fullName of opts.repos) await ensureRepoLabels(app, info, fullName, out);
	out.addSecrets(...app.mintedTokens);
	return out.summary();
}

async function configureWebhook(app: GitHubApp, info: AppInfo, url: string, secret: string, out: Reporter): Promise<void> {
	const current = await app.getHookConfig();
	// GitHub masks the stored secret, so it can't be compared: it's always sent.
	await app.updateHookConfig({ url, content_type: "json", insecure_ssl: "0", secret });
	if (current.url === url) out.pass(`webhook URL already ${url}`);
	else out.pass(`webhook URL set to ${url}${current.url ? ` (was ${current.url})` : ""}`);
	if (current.content_type === "json") out.pass("webhook content type already json");
	else out.pass(`webhook content type set to json${current.content_type ? ` (was ${current.content_type})` : ""}`);
	out.pass("webhook secret set (the gateway's GITHUB_WEBHOOK_SECRET must be the same value)");

	// The REST API can't activate an App webhook (PATCH /app/hook/config has no `active`). A delivery proves it's on.
	const settings = appSettingsUrl(info, app.apiUrl);
	let deliveries: Awaited<ReturnType<GitHubApp["recentDeliveries"]>> = [];
	try {
		deliveries = await app.recentDeliveries(1);
	} catch (error) {
		out.warn(`could not list webhook deliveries: ${errorMessage(error)}`);
	}
	if (deliveries.length > 0) {
		out.pass(`webhook is delivering (latest ${deliveries[0]?.event} at ${deliveries[0]?.delivered_at})`);
	} else {
		out.warn(
			"webhook activation can't be set through the API: turn it on by hand",
			`Open ${settings}, check Webhook > Active, and click Save changes. Leave the URL and secret as they are.`,
		);
	}
}

async function ensureRepoLabels(app: GitHubApp, info: AppInfo, fullName: string, out: Reporter): Promise<void> {
	out.heading(fullName);
	try {
		const { owner, name } = splitRepo(fullName);
		const installation = await app.repoInstallation(owner, name);
		if (!installation) {
			out.fail(`${info.slug} is not installed on ${fullName}`, `Install it at ${info.html_url}/installations/new`);
			return;
		}
		const token = await app.installationToken(installation.id, name, { issues: "write", metadata: "read" });
		out.addSecrets(token);
		const repo = app.repo(owner, name, token);
		const existing = new Set((await repo.listLabels()).map((label) => label.name.toLowerCase()));
		for (const label of LABELS) {
			if (existing.has(label.name.toLowerCase())) {
				out.pass(`label ${label.name} exists`);
				continue;
			}
			await repo.createLabel({ name: label.name, color: label.color, description: label.description });
			out.pass(`label ${label.name} created`);
		}
	} catch (error) {
		out.fail(`could not set up ${fullName}: ${errorMessage(error)}`);
	}
}
