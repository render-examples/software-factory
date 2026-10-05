/**
 * Diagnose a deployment without changing anything.
 *
 * Every check reports what is wrong and how to fix it. Read-only by design:
 * it never creates or edits a resource.
 */
import {
	allowedActors,
	repository,
	triggerLabel,
} from "../app/config/index.js";
import { validateConfig } from "../app/config/index.js";
import { githubToken } from "../app/github/index.js";
import { db } from "../app/store/index.js";
import { type Finding, exitWith, heading, print } from "./support.js";

const API = process.env.GITHUB_API_URL ?? "https://api.github.com";
const findings: Finding[] = [];

function record(finding: Finding): void {
	findings.push(finding);
	print(finding);
}

function present(name: string, fix: string): boolean {
	if (process.env[name]?.trim()) {
		record({ level: "ok", message: `${name} is set` });
		return true;
	}
	record({ level: "fail", message: `${name} is missing`, fix });
	return false;
}

async function github<T>(
	path: string,
	token: string,
): Promise<{ ok: boolean; status: number; body: T | null }> {
	try {
		const response = await fetch(`${API}${path}`, {
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
				"User-Agent": "render-factory-doctor",
			},
			signal: AbortSignal.timeout(15_000),
		});
		const body = response.ok ? ((await response.json()) as T) : null;
		return { ok: response.ok, status: response.status, body };
	} catch {
		return { ok: false, status: 0, body: null };
	}
}

function checkConfiguration(): void {
	heading("Configuration");

	try {
		validateConfig();
		record({ level: "ok", message: "factory.config.ts is valid" });
	} catch (error) {
		record({
			level: "fail",
			message: "factory.config.ts is invalid",
			fix: error instanceof Error ? error.message : "Check factory.config.ts",
		});
	}

	try {
		const repo = repository();
		record({ level: "ok", message: `Target repository is ${repo.fullName}` });
	} catch (error) {
		record({
			level: "fail",
			message: "Target repository is not configured",
			fix:
				error instanceof Error
					? error.message
					: "Set repos[0] in factory.config.ts",
		});
	}

	try {
		const actors = allowedActors();
		record({
			level: "ok",
			message: `${actors.size} allowed actor${actors.size === 1 ? "" : "s"}`,
		});
	} catch {
		record({
			level: "fail",
			message: "No allowed actors",
			fix: "Set FACTORY_GITHUB_ACTORS or add actors to factory.config.ts.",
		});
	}

	const secret = process.env.GITHUB_WEBHOOK_SECRET?.trim() ?? "";
	if (!secret) {
		record({
			level: "fail",
			message: "GITHUB_WEBHOOK_SECRET is missing",
			fix: "Generate one with: openssl rand -hex 32",
		});
	} else if (secret.length < 32) {
		record({
			level: "warn",
			message: `GITHUB_WEBHOOK_SECRET is only ${secret.length} characters`,
			fix: "Use at least 32. Generate with: openssl rand -hex 32",
		});
	} else {
		record({ level: "ok", message: "GITHUB_WEBHOOK_SECRET looks strong" });
	}

	present("DATABASE_URL", "All processes must point at the same database.");
	present("ANTHROPIC_API_KEY", "Required by the workflows host.");
	present("RENDER_WORKSPACE_ID", "Required to create sandboxes.");

	const hasApp =
		process.env.GITHUB_APP_ID?.trim() &&
		process.env.GITHUB_APP_PRIVATE_KEY?.trim() &&
		process.env.GITHUB_APP_INSTALLATION_ID?.trim();
	if (hasApp) {
		record({
			level: "ok",
			message: "GitHub App credentials configured",
		});
	} else {
		record({
			level: "fail",
			message: "No GitHub App credentials",
			fix: "Set GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, and GITHUB_APP_INSTALLATION_ID. Run npm run setup:app to create one.",
		});
	}
}

async function checkGitHub(): Promise<void> {
	heading("GitHub");

	let token: string;
	try {
		token = await githubToken();
	} catch (error) {
		record({
			level: "fail",
			message: "Could not obtain a GitHub token",
			fix: error instanceof Error ? error.message : undefined,
		});
		return;
	}

	let repo: ReturnType<typeof repository>;
	try {
		repo = repository();
	} catch {
		record({
			level: "warn",
			message: "Skipped — target repository is not configured",
			fix: "Set repos[0] in factory.config.ts, then run this again.",
		});
		return;
	}

	const base = `/repos/${repo.owner}/${repo.repo}`;
	const info = await github<{ permissions?: Record<string, boolean> }>(
		base,
		token,
	);
	if (!info.ok) {
		record({
			level: "fail",
			message: `Cannot read ${repo.fullName} (HTTP ${info.status || "network error"})`,
			fix: "Check the App is installed on this repository.",
		});
		return;
	}
	record({ level: "ok", message: `Can read ${repo.fullName}` });

	const permissions = info.body?.permissions;
	if (permissions && !permissions.push) {
		record({
			level: "fail",
			message: "Credential cannot push",
			fix: "Grant Contents: write so the factory can push its branch.",
		});
	} else if (permissions) {
		record({ level: "ok", message: "Credential can push" });
	}

	const label = triggerLabel();
	const labelCheck = await github(
		`${base}/labels/${encodeURIComponent(label)}`,
		token,
	);
	record(
		labelCheck.ok
			? { level: "ok", message: `Trigger label "${label}" exists` }
			: {
					level: "fail",
					message: `Trigger label "${label}" does not exist`,
					fix: "Run npm run setup:github, or create it by hand.",
				},
	);

	await checkWebhook(base, token);
}

async function checkWebhook(base: string, token: string): Promise<void> {
	const hooks = await github<
		Array<{ active: boolean; events: string[]; config: { url?: string } }>
	>(`${base}/hooks`, token);

	if (!hooks.ok) {
		record({
			level: "warn",
			message: `Cannot list webhooks (HTTP ${hooks.status})`,
			fix: "The App may not have admin:repo_hook. Skipping the webhook check.",
		});
		return;
	}

	const all = hooks.body ?? [];
	const ours = all.filter((hook) =>
		hook.config.url?.includes("/webhooks/github"),
	);

	if (ours.length === 0) {
		const others = all.map((hook) => hook.config.url).filter(Boolean);
		record({
			level: "fail",
			message: "No webhook points at /webhooks/github",
			fix:
				others.length > 0
					? `Run npm run setup:github. Existing webhooks: ${others.join(", ")}`
					: "Run npm run setup:github to create it.",
		});
		return;
	}

	const hook = ours[0];
	record({ level: "ok", message: `Webhook points at ${hook.config.url}` });

	record(
		hook.active
			? { level: "ok", message: "Webhook is active" }
			: {
					level: "fail",
					message: "Webhook is inactive",
					fix: "Enable it in repository settings.",
				},
	);

	record(
		hook.events.includes("issues")
			? { level: "ok", message: "Webhook subscribes to issues" }
			: {
					level: "fail",
					message: `Webhook subscribes to ${hook.events.join(", ") || "nothing"}`,
					fix: "It must include the issues event.",
				},
	);
}

async function checkPostgres(): Promise<void> {
	heading("Postgres");

	if (!process.env.DATABASE_URL?.trim()) {
		record({
			level: "warn",
			message: "Skipped — DATABASE_URL is not set",
			fix: "Set it, then run this again.",
		});
		return;
	}

	try {
		const { rows } = await db().query<{ column_name: string }>(
			`select column_name from information_schema.columns
			 where table_schema = 'public' and table_name = 'runs'`,
		);
		if (rows.length === 0) {
			record({
				level: "fail",
				message: "The runs table does not exist",
				fix: "Apply the schema with npm run db:migrate.",
			});
			return;
		}
		record({ level: "ok", message: "Connected, runs table present" });

		const columns = new Set(rows.map((row) => row.column_name));
		const missing = ["id", "status", "repo", "workflow"].filter(
			(name) => !columns.has(name),
		);
		record(
			missing.length === 0
				? { level: "ok", message: "runs has the expected columns" }
				: {
						level: "fail",
						message: `runs is missing: ${missing.join(", ")}`,
						fix: "This database predates the current schema. Run npm run db:migrate.",
					},
		);

		const { rows: indexes } = await db().query<{ indexname: string }>(
			"select indexname from pg_indexes where schemaname='public' and tablename='runs'",
		);
		const names = new Set(indexes.map((row) => row.indexname));
		record(
			names.has("runs_one_active_per_subject")
				? { level: "ok", message: "Per-subject uniqueness index present" }
				: {
						level: "fail",
						message: "runs_one_active_per_subject is missing",
						fix: "Without it, one subject can start concurrent runs. Re-run npm run db:migrate.",
					},
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const fix = /ssl/i.test(message)
			? `${message}. Append ?sslmode=require when connecting to a Render database from outside Render.`
			: message;
		record({ level: "fail", message: "Cannot reach Postgres", fix });
	}
}

async function checkTasks(): Promise<void> {
	heading("Task registration");

	try {
		const { TaskRegistry } = await import("@renderinc/sdk/workflows");
		await import("../app/tasks/index.js");
		await import("../app/workflows/index.js");

		const registered = new Set(TaskRegistry.getInstance().getAllTaskNames());
		const expected = [
			"triage",
			"analyst",
			"implementer",
			"self-review",
			"security",
			"correctness",
			"tests",
			"judge",
			"spec-to-pr",
		];
		const missing = expected.filter((name) => !registered.has(name));

		record(
			missing.length === 0
				? { level: "ok", message: `All ${expected.length} tasks registered` }
				: {
						level: "fail",
						message: `Not registered: ${missing.join(", ")}`,
						fix: "Every agent must be wrapped in app/tasks/index.ts and every workflow exported from app/workflows/index.ts.",
					},
		);
	} catch (error) {
		record({
			level: "fail",
			message: "Could not load task registrations",
			fix: error instanceof Error ? error.message : undefined,
		});
	}
}

checkConfiguration();
await checkGitHub();
await checkPostgres();
await checkTasks();

if (process.env.DATABASE_URL?.trim()) {
	await db()
		.end()
		.catch(() => {});
}
exitWith(findings);
