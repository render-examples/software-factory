import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DATABASE_URL =
	process.env.DATABASE_URL ??
	"postgresql://postgres:postgres@localhost:55432/rf_m6";
const sqlDir = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"app",
	"sql",
);

let pool: pg.Pool;

async function applyMigrations(client: pg.PoolClient): Promise<void> {
	await client.query(`
		CREATE TABLE IF NOT EXISTS schema_migrations (
			filename text PRIMARY KEY,
			applied_at timestamptz NOT NULL DEFAULT now()
		)
	`);
	const files = (await readdir(sqlDir))
		.filter((f) => f.endsWith(".sql"))
		.sort();
	const { rows } = await client.query("SELECT filename FROM schema_migrations");
	const applied = new Set(rows.map((r: { filename: string }) => r.filename));
	for (const file of files) {
		if (applied.has(file)) continue;
		const sql = await readFile(join(sqlDir, file), "utf8");
		await client.query("BEGIN");
		await client.query(sql);
		await client.query(
			"INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING",
			[file],
		);
		await client.query("COMMIT");
	}
}

beforeAll(async () => {
	pool = new pg.Pool({
		connectionString: DATABASE_URL,
		max: 5,
		application_name: "rf_m6_triage_test",
	});
	const client = await pool.connect();
	try {
		await client.query("DROP SCHEMA public CASCADE");
		await client.query("CREATE SCHEMA public");
		await applyMigrations(client);
	} finally {
		client.release();
	}
});

afterAll(async () => {
	await pool.end();
});

describe("spec versioning and superseding", () => {
	it("creates a spec, adds versions, and supersedes", async () => {
		const specId = randomUUID();

		const {
			createSpec,
			addSpecVersion,
			getSpec,
			getCurrentSpec,
			supersedeSpec,
		} = await import("../../app/store/specs.js");

		await createSpec({ id: specId, repo: "o/r", issueNumber: 800 });

		const v1 = await addSpecVersion({
			specId,
			document: { title: "v1" },
			markdown: "# v1",
			notes: { findings: "found stuff", relevantPaths: ["src/a.ts"] },
			lastCommentId: "100",
			runId: "run-1",
		});
		expect(v1).toBe(1);

		const v2 = await addSpecVersion({
			specId,
			document: { title: "v2" },
			markdown: "# v2",
			notes: { findings: "more stuff", relevantPaths: ["src/b.ts"] },
			lastCommentId: "200",
			runId: "run-2",
		});
		expect(v2).toBe(2);

		const spec = await getSpec(specId);
		expect(spec?.currentVersion).toBe(2);
		expect(spec?.status).toBe("draft");

		// Supersede
		await supersedeSpec(specId);
		const superseded = await getSpec(specId);
		expect(superseded?.status).toBe("superseded");

		// getCurrentSpec should not return superseded specs
		const current = await getCurrentSpec("o/r", 800);
		expect(current).toBeNull();

		// Cleanup
		await pool.query("DELETE FROM spec_versions WHERE spec_id = $1", [specId]);
		await pool.query("DELETE FROM specs WHERE id = $1", [specId]);
	});

	it("stores and retrieves spec versions with notes", async () => {
		const specId = randomUUID();

		const { createSpec, addSpecVersion, getSpecVersion } = await import(
			"../../app/store/specs.js"
		);

		await createSpec({ id: specId, repo: "o/r", issueNumber: 801 });

		await addSpecVersion({
			specId,
			document: { title: "test", goals: ["a", "b"] },
			markdown: "# test",
			notes: { findings: "found things", relevantPaths: ["x.ts", "y.ts"] },
			lastCommentId: "42",
			runId: "run-abc",
		});

		const v = await getSpecVersion(specId, 1);
		expect(v).not.toBeNull();
		expect(v?.document).toEqual({ title: "test", goals: ["a", "b"] });
		expect(v?.notes).toEqual({
			findings: "found things",
			relevantPaths: ["x.ts", "y.ts"],
		});
		expect(v?.lastCommentId).toBe("42");
		expect(v?.runId).toBe("run-abc");

		await pool.query("DELETE FROM spec_versions WHERE spec_id = $1", [specId]);
		await pool.query("DELETE FROM specs WHERE id = $1", [specId]);
	});

	it("setSpecCommentId persists the comment ID", async () => {
		const specId = randomUUID();

		const { createSpec, setSpecCommentId, getSpec } = await import(
			"../../app/store/specs.js"
		);

		await createSpec({ id: specId, repo: "o/r", issueNumber: 802 });
		await setSpecCommentId(specId, "comment-99");

		const spec = await getSpec(specId);
		expect(spec?.commentId).toBe("comment-99");

		await pool.query("DELETE FROM specs WHERE id = $1", [specId]);
	});

	it("approveVersion binds approval to a specific version", async () => {
		const specId = randomUUID();

		const { createSpec, addSpecVersion, approveVersion, getSpec } =
			await import("../../app/store/specs.js");

		await createSpec({ id: specId, repo: "o/r", issueNumber: 803 });
		await addSpecVersion({
			specId,
			document: { title: "v1" },
			markdown: "# v1",
		});

		const approved = await approveVersion(specId, 1, "Maintainer");
		expect(approved).toBe(true);

		const spec = await getSpec(specId);
		expect(spec?.status).toBe("approved");
		expect(spec?.approvedVersion).toBe(1);
		expect(spec?.approvedBy).toBe("Maintainer");

		// Cannot approve a superseded spec
		await pool.query("UPDATE specs SET status = 'superseded' WHERE id = $1", [
			specId,
		]);
		const rejected = await approveVersion(specId, 1, "Other");
		expect(rejected).toBe(false);

		await pool.query("DELETE FROM spec_versions WHERE spec_id = $1", [specId]);
		await pool.query("DELETE FROM specs WHERE id = $1", [specId]);
	});

	it("prevents approving a non-existent version", async () => {
		const specId = randomUUID();

		const { createSpec, approveVersion } = await import(
			"../../app/store/specs.js"
		);

		await createSpec({ id: specId, repo: "o/r", issueNumber: 804 });

		const result = await approveVersion(specId, 99, "Maintainer");
		expect(result).toBe(false);

		await pool.query("DELETE FROM specs WHERE id = $1", [specId]);
	});
});

describe("follow-up run in finishRun transaction", () => {
	it("creates a follow-up triage run when finishing a triage run", async () => {
		const runId = randomUUID();
		const followUpId = randomUUID();

		await pool.query(
			`INSERT INTO runs (id, repo, subject_kind, subject_number, workflow, status)
			 VALUES ($1, 'o/r', 'issue', 850, 'triage', 'running')`,
			[runId],
		);

		const { finishRun } = await import("../../app/store/runs.js");
		const result = await finishRun(runId, "completed", {
			outcome: "spec_drafted",
			followUp: {
				id: followUpId,
				repo: "o/r",
				subjectKind: "issue",
				subjectNumber: 850,
				workflow: "triage",
				previousRunId: runId,
				trigger: { event: "follow_up" },
				input: { autoAdvance: false },
			},
		});

		expect(result.finished).toBe(true);
		expect(result.followUpCreated).toBe(true);

		const { rows } = await pool.query(
			"SELECT id, status, workflow, previous_run_id FROM runs WHERE id = $1",
			[followUpId],
		);
		expect(rows).toHaveLength(1);
		expect(rows[0].status).toBe("queued");
		expect(rows[0].workflow).toBe("triage");
		expect(rows[0].previous_run_id).toBe(runId);

		await pool.query("DELETE FROM runs WHERE id IN ($1, $2)", [
			runId,
			followUpId,
		]);
	});
});
