/**
 * Create the webhook and trigger label on the target repository.
 *
 * Idempotent: an existing factory webhook is updated in place rather than
 * duplicated, and an existing label is left alone.
 *
 *   npm run setup:github -- --gateway-url https://my-gateway.onrender.com
 *   npm run setup:github -- --gateway-url ... --secret <hex> --yes
 */
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { repository, triggerLabel } from "../app/config/index.js";
import { githubToken } from "../app/github/index.js";
import { ask, bold, confirm, dim, exitWith, heading, print, type Finding } from "./support.js";

const API = process.env.GITHUB_API_URL ?? "https://api.github.com";
const LABEL_COLOR = "5a78f0";

const { values } = parseArgs({
	options: {
		"gateway-url": { type: "string" },
		secret: { type: "string" },
		yes: { type: "boolean", default: false },
	},
	allowPositionals: true,
});

const findings: Finding[] = [];

function record(finding: Finding): void {
	findings.push(finding);
	print(finding);
}

const repo = repository();
const label = triggerLabel();
const token = await githubToken();
const base = `${API}/repos/${repo.owner}/${repo.repo}`;

async function call<T>(
	method: string,
	url: string,
	body?: unknown,
): Promise<{ ok: boolean; status: number; body: T | null }> {
	const response = await fetch(url, {
		method,
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
			"User-Agent": "render-factory-setup",
			...(body ? { "Content-Type": "application/json" } : {}),
		},
		body: body ? JSON.stringify(body) : undefined,
		signal: AbortSignal.timeout(15_000),
	});
	const parsed = response.ok ? ((await response.json()) as T) : null;
	return { ok: response.ok, status: response.status, body: parsed };
}

async function resolveGatewayUrl(): Promise<string> {
	const provided = values["gateway-url"]?.trim();
	const url = provided || (await ask("Gateway URL", "https://render-factory-gateway.onrender.com"));
	return url.replace(/\/+$/, "");
}

async function ensureWebhook(gatewayUrl: string, secret: string): Promise<void> {
	heading("Webhook");
	const target = `${gatewayUrl}/webhooks/github`;

	const existing = await call<
		Array<{ id: number; config: { url?: string } }>
	>("GET", `${base}/hooks`);
	if (!existing.ok) {
		record({
			level: "fail",
			message: `Cannot list webhooks (HTTP ${existing.status})`,
			fix: "A PAT needs admin:repo_hook. A GitHub App configures its own webhook instead.",
		});
		return;
	}

	// Update a hook already aimed at this gateway rather than adding a second.
	const mine = (existing.body ?? []).find(
		(hook) =>
			hook.config.url?.startsWith(gatewayUrl) ||
			hook.config.url?.includes("/webhooks/github"),
	);

	const config = {
		url: target,
		content_type: "json",
		secret,
		insecure_ssl: "0",
	};

	if (mine) {
		const updated = await call("PATCH", `${base}/hooks/${mine.id}`, {
			config,
			events: ["issues"],
			active: true,
		});
		record(
			updated.ok
				? { level: "ok", message: `Updated webhook ${mine.id} to ${target}` }
				: { level: "fail", message: `Could not update webhook (HTTP ${updated.status})` },
		);
		return;
	}

	const created = await call("POST", `${base}/hooks`, {
		name: "web",
		active: true,
		events: ["issues"],
		config,
	});
	record(
		created.ok
			? { level: "ok", message: `Created webhook pointing at ${target}` }
			: { level: "fail", message: `Could not create webhook (HTTP ${created.status})` },
	);
}

async function ensureLabel(): Promise<void> {
	heading("Trigger label");

	const found = await call("GET", `${base}/labels/${encodeURIComponent(label)}`);
	if (found.ok) {
		record({ level: "ok", message: `Label "${label}" already exists` });
		return;
	}

	const created = await call("POST", `${base}/labels`, {
		name: label,
		color: LABEL_COLOR,
		description: "Hand this issue to the factory",
	});
	record(
		created.ok
			? { level: "ok", message: `Created label "${label}"` }
			: { level: "fail", message: `Could not create label (HTTP ${created.status})` },
	);
}

console.log(`\nConfiguring ${bold(repo.fullName)}`);

const gatewayUrl = await resolveGatewayUrl();
const secret = values.secret?.trim() || process.env.GITHUB_WEBHOOK_SECRET?.trim() || randomBytes(32).toString("hex");
const generated = !values.secret && !process.env.GITHUB_WEBHOOK_SECRET;

if (!values.yes) {
	console.log(`\n  webhook  ${gatewayUrl}/webhooks/github`);
	console.log(`  label    ${label}`);
	console.log(`  secret   ${generated ? "newly generated" : "from --secret or the environment"}`);
	if (!(await confirm("\nApply this?"))) {
		console.log("Nothing changed.");
		process.exit(0);
	}
}

await ensureWebhook(gatewayUrl, secret);
await ensureLabel();

if (generated) {
	console.log(`\n${bold("Set this on the gateway as GITHUB_WEBHOOK_SECRET:")}`);
	console.log(`\n  ${secret}\n`);
	console.log(dim("The webhook already has it. Deliveries fail until the gateway does too."));
}

exitWith(findings);
