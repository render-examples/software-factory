/**
 * Diagnose a deployment without changing anything.
 *
 * Every check reports what is wrong and how to fix it. Read-only by design:
 * it never creates or edits a resource. Safe to run in CI — network checks
 * are skipped cleanly when credentials are absent.
 */
import { factoryConfig } from "../factory.config.js";
import { repository } from "../app/config/index.js";
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

// ── Config validation ────────────────────────────────────────────────
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

// ── Per-process env ──────────────────────────────────────────────────
function checkGatewayEnv(): void {
	heading("Gateway environment");

	present(
		"GITHUB_WEBHOOK_SECRET",
		"Required by the gateway to verify webhook signatures.",
	);
	present("FACTORY_ADMIN_TOKEN", "Required for the read API and trace UI.");
	present("DATABASE_URL", "Gateway needs Postgres for run state.");
}

function checkDispatcherEnv(): void {
	heading("Dispatcher environment");

	present(
		"RENDER_API_KEY",
		"Required by the dispatcher to start workflow tasks.",
	);
	present(
		"RENDER_WORKFLOW_SLUG",
		"The slug of the factory-workflows service. Set it or use fromService in render.yaml.",
	);
}

function checkWorkflowsEnv(): void {
	heading("Workflows environment");

	present("ANTHROPIC_API_KEY", "Required to run Claude agents.");
	present("RENDER_API_KEY", "Required for sandbox operations.");
	present("RENDER_WORKSPACE_ID", "Required to create sandboxes.");
	present("DATABASE_URL", "Workflows host needs Postgres for run state.");

	const hasApp =
		process.env.GITHUB_APP_ID?.trim() &&
		process.env.GITHUB_APP_PRIVATE_KEY?.trim() &&
		process.env.GITHUB_APP_INSTALLATION_ID?.trim();
	if (hasApp) {
		record({ level: "ok", message: "GitHub App credentials set" });
	} else {
		record({
			level: "fail",
			message: "Missing GitHub App credentials for workflows",
			fix: "Set GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, and GITHUB_APP_INSTALLATION_ID.",
		});
	}
}

function checkMaintenanceEnv(): void {
	heading("Maintenance environment");

	present("RENDER_API_KEY", "Required for sandbox lifecycle.");
	present("RENDER_WORKSPACE_ID", "Required to manage the warm pool.");
}

// ── GitHub App installation and permissions ──────────────────────────
async function checkGitHubApp(base: string, token: string): Promise<void> {
	heading("GitHub App installation");

	const installation = await github<{
		permissions?: Record<string, string>;
		events?: string[];
	}>(`${base}/installation`, token);

	if (!installation.ok) {
		record({
			level: "fail",
			message: `Cannot read App installation (HTTP ${installation.status || "network error"})`,
			fix: "Ensure the App is installed on this repository. Run npm run setup:app.",
		});
		return;
	}

	record({ level: "ok", message: "GitHub App is installed" });

	const perms = installation.body?.permissions ?? {};
	const requiredPerms: Record<string, string> = {
		contents: "write",
		issues: "write",
		pull_requests: "write",
		metadata: "read",
	};

	for (const [perm, level] of Object.entries(requiredPerms)) {
		const has = perms[perm];
		if (has === level || has === "write" || has === "admin") {
			record({ level: "ok", message: `App has ${perm}: ${has}` });
		} else {
			record({
				level: "fail",
				message: `App missing ${perm}: ${level} (has: ${has ?? "none"})`,
				fix: `Update the App permissions to include ${perm}: ${level}.`,
			});
		}
	}
}

// ── GitHub: labels, webhook, permissions ─────────────────────────────
async function checkGitHub(): Promise<void> {
	heading("GitHub");

	let token: string;
	try {
		token = await githubToken();
	} catch (error) {
		record({
			level: "warn",
			message: "Skipped — could not obtain a GitHub token",
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

	// Check all four trigger labels exist.
	const labels = factoryConfig.labels;
	for (const [key, labelName] of Object.entries(labels)) {
		const labelCheck = await github(
			`${base}/labels/${encodeURIComponent(labelName)}`,
			token,
		);
		record(
			labelCheck.ok
				? { level: "ok", message: `Label "${labelName}" (${key}) exists` }
				: {
						level: "fail",
						message: `Label "${labelName}" (${key}) does not exist`,
						fix: "Run npm run setup:github, or create it by hand.",
					},
		);
	}

	await checkWebhook(base, token);
	await checkGitHubApp(base, token);
	await checkPreviewConfig(base, token);
}

async function checkWebhook(base: string, token: string): Promise<void> {
	heading("Webhook");

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

	const requiredEvents = ["issues", "issue_comment", "pull_request"];
	for (const event of requiredEvents) {
		record(
			hook.events.includes(event)
				? { level: "ok", message: `Webhook subscribes to ${event}` }
				: {
						level: "fail",
						message: `Webhook does not subscribe to ${event}`,
						fix: `Add ${event} to the webhook events.`,
					},
		);
	}
}

// ── Preview configuration ────────────────────────────────────────────
async function checkPreviewConfig(base: string, token: string): Promise<void> {
	const target = factoryConfig.repos[0];
	if (!target.preview) {
		record({
			level: "ok",
			message: "No preview environment configured (optional)",
		});
		return;
	}

	heading("Preview configuration");

	record({
		level: "ok",
		message: `Preview service name: ${target.preview.serviceName}`,
	});

	// Check that the target repo has a render.yaml with the service name.
	const renderYaml = await github<{ content?: string }>(
		`${base}/contents/render.yaml`,
		token,
	);

	if (!renderYaml.ok) {
		record({
			level: "warn",
			message: "Could not read render.yaml from the target repository",
			fix: "The target repository needs a render.yaml with preview environments enabled.",
		});
	} else {
		record({
			level: "ok",
			message: "Target repository has a render.yaml",
		});
	}
}

// ── Postgres ─────────────────────────────────────────────────────────
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

		// Check migration version.
		try {
			const { rows: migrationRows } = await db().query<{ version: string }>(
				"SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1",
			);
			if (migrationRows.length > 0) {
				record({
					level: "ok",
					message: `Latest migration: ${migrationRows[0].version}`,
				});
			}
		} catch {
			// schema_migrations may not exist in older setups.
			record({
				level: "warn",
				message: "Could not read schema_migrations table",
				fix: "Run npm run db:migrate to apply all migrations.",
			});
		}

		// Check warm pool health.
		try {
			const { rows: poolRows } = await db().query<{
				status: string;
				count: string;
			}>("SELECT status, count(*)::text FROM sandboxes GROUP BY status");
			if (poolRows.length > 0) {
				const counts = poolRows
					.map((r) => `${r.status}: ${r.count}`)
					.join(", ");
				record({ level: "ok", message: `Sandbox pool: ${counts}` });
			} else {
				record({
					level: "ok",
					message: "Sandbox pool is empty (normal before first run)",
				});
			}
		} catch {
			record({
				level: "warn",
				message: "Could not query sandboxes table",
				fix: "The sandboxes table may not exist. Run npm run db:migrate.",
			});
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const fix = /ssl/i.test(message)
			? `${message}. Append ?sslmode=require when connecting to a Render database from outside Render.`
			: message;
		record({ level: "fail", message: "Cannot reach Postgres", fix });
	}
}

// ── Task registration ────────────────────────────────────────────────
async function checkTasks(): Promise<void> {
	heading("Task registration");

	try {
		const { TaskRegistry } = await import("@renderinc/sdk/workflows");
		await import("../app/tasks/index.js");
		await import("../app/workflows/index.js");

		const registered = new Set(TaskRegistry.getInstance().getAllTaskNames());
		const expected = [
			"triage",
			"spec-writer",
			"implementer",
			"self-review",
			"security-reviewer",
			"correctness-reviewer",
			"performance-reviewer",
			"tests-reviewer",
			"synthesizer",
			"ux-tester",
			"spec-to-pr",
			"pr-review",
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

// ── Run all checks ──────────────────────────────────────────────────
checkConfiguration();
checkGatewayEnv();
checkDispatcherEnv();
checkWorkflowsEnv();
checkMaintenanceEnv();
await checkGitHub();
await checkPostgres();
await checkTasks();

if (process.env.DATABASE_URL?.trim()) {
	await db()
		.end()
		.catch(() => {});
}
exitWith(findings);
