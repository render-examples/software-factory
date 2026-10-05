import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:55432/rf_m2";
const sqlDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "app", "sql");

let pool: pg.Pool;

async function applyMigrations(client: pg.PoolClient): Promise<void> {
	await client.query(`
		CREATE TABLE IF NOT EXISTS schema_migrations (
			filename text PRIMARY KEY,
			applied_at timestamptz NOT NULL DEFAULT now()
		)
	`);
	const files = (await readdir(sqlDir)).filter((f) => f.endsWith(".sql")).sort();
	const { rows } = await client.query("SELECT filename FROM schema_migrations");
	const applied = new Set(rows.map((r: { filename: string }) => r.filename));
	for (const file of files) {
		if (applied.has(file)) continue;
		const sql = await readFile(join(sqlDir, file), "utf8");
		await client.query("BEGIN");
		await client.query(sql);
		await client.query("INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING", [file]);
		await client.query("COMMIT");
	}
}

beforeAll(async () => {
	pool = new pg.Pool({
		connectionString: DATABASE_URL,
		max: 5,
		application_name: "rf_m2_test",
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

describe("migrations", () => {
	it("apply twice idempotently", async () => {
		const client = await pool.connect();
		try {
			await applyMigrations(client);
			const { rows } = await client.query("SELECT filename FROM schema_migrations ORDER BY filename");
			expect(rows.length).toBeGreaterThanOrEqual(2);
		} finally {
			client.release();
		}
	});

	it("schema_migrations tracks applied files", async () => {
		const { rows } = await pool.query("SELECT filename FROM schema_migrations ORDER BY filename");
		const filenames = rows.map((r: { filename: string }) => r.filename);
		expect(filenames).toContain("0001_init.sql");
		expect(filenames).toContain("0002_phases.sql");
	});
});

describe("migrations on top of 0001 data", () => {
	it("old run statuses are migrated correctly", async () => {
		const client = await pool.connect();
		try {
			await client.query("DROP SCHEMA public CASCADE");
			await client.query("CREATE SCHEMA public");

			// Apply only 0001
			const sql0001 = await readFile(join(sqlDir, "0001_init.sql"), "utf8");
			await client.query(sql0001);

			// Insert rows with old statuses
			await client.query(
				`INSERT INTO runs (id, delivery_id, issue_number, status) VALUES
				 ('old-running', 'del-1', 1, 'running'),
				 ('old-draft', 'del-2', 2, 'draft_pr_opened'),
				 ('old-needs', 'del-3', 3, 'needs_clarification'),
				 ('old-no-ch', 'del-4', 4, 'no_changes'),
				 ('old-changes', 'del-5', 5, 'changes_requested'),
				 ('old-failed', 'del-6', 6, 'failed')`,
			);

			// Now apply 0002 on top
			await client.query(`
				CREATE TABLE IF NOT EXISTS schema_migrations (
					filename text PRIMARY KEY,
					applied_at timestamptz NOT NULL DEFAULT now()
				)
			`);
			await client.query("INSERT INTO schema_migrations (filename) VALUES ('0001_init.sql') ON CONFLICT DO NOTHING");
			const sql0002 = await readFile(join(sqlDir, "0002_phases.sql"), "utf8");
			await client.query(sql0002);
			await client.query("INSERT INTO schema_migrations (filename) VALUES ('0002_phases.sql') ON CONFLICT DO NOTHING");

			// Check status migrations
			const { rows } = await client.query("SELECT id, status, outcome, repo FROM runs ORDER BY id");
			const byId = Object.fromEntries(rows.map((r: Record<string, unknown>) => [r.id, r]));

			expect(byId["old-running"].status).toBe("running");
			expect(byId["old-draft"].status).toBe("completed");
			expect(byId["old-draft"].outcome).toBe("draft_pr_opened");
			expect(byId["old-needs"].status).toBe("completed");
			expect(byId["old-needs"].outcome).toBe("needs_clarification");
			expect(byId["old-no-ch"].status).toBe("completed");
			expect(byId["old-no-ch"].outcome).toBe("no_changes");
			expect(byId["old-changes"].status).toBe("completed");
			expect(byId["old-changes"].outcome).toBe("changes_requested");
			expect(byId["old-failed"].status).toBe("failed");
			expect(byId["old-failed"].outcome).toBe("error");

			// Verify repo was backfilled
			for (const row of rows) {
				expect((row as Record<string, unknown>).repo).toBe("unknown/unknown");
			}
		} finally {
			client.release();
		}

		// Re-establish clean state for subsequent tests
		const c2 = await pool.connect();
		try {
			await c2.query("DROP SCHEMA public CASCADE");
			await c2.query("CREATE SCHEMA public");
			await applyMigrations(c2);
		} finally {
			c2.release();
		}
	});
});

describe("one-active-run-per-subject index", () => {
	it("prevents two queued runs for the same subject", async () => {
		const id1 = randomUUID();
		const id2 = randomUUID();

		await pool.query(
			`INSERT INTO runs (id, repo, subject_kind, subject_number, workflow, status)
			 VALUES ($1, 'o/r', 'issue', 99, 'spec-to-pr', 'queued')`,
			[id1],
		);

		const result = await pool.query(
			`INSERT INTO runs (id, repo, subject_kind, subject_number, workflow, status)
			 VALUES ($1, 'o/r', 'issue', 99, 'spec-to-pr', 'queued')
			 ON CONFLICT DO NOTHING`,
			[id2],
		);
		expect(result.rowCount).toBe(0);

		// Clean up
		await pool.query("DELETE FROM runs WHERE id IN ($1, $2)", [id1, id2]);
	});

	it("allows a new run after the first completes", async () => {
		const id1 = randomUUID();
		const id2 = randomUUID();

		await pool.query(
			`INSERT INTO runs (id, repo, subject_kind, subject_number, workflow, status)
			 VALUES ($1, 'o/r', 'issue', 100, 'spec-to-pr', 'queued')`,
			[id1],
		);
		await pool.query(
			"UPDATE runs SET status = 'completed', outcome = 'done' WHERE id = $1",
			[id1],
		);

		const result = await pool.query(
			`INSERT INTO runs (id, repo, subject_kind, subject_number, workflow, status)
			 VALUES ($1, 'o/r', 'issue', 100, 'spec-to-pr', 'queued')
			 ON CONFLICT DO NOTHING`,
			[id2],
		);
		expect(result.rowCount).toBe(1);

		// Clean up
		await pool.query("DELETE FROM runs WHERE id IN ($1, $2)", [id1, id2]);
	});
});

describe("finishRun with follow-up", () => {
	it("finishes a run and creates a follow-up in one transaction", async () => {
		const runId = randomUUID();
		const followUpId = randomUUID();

		await pool.query(
			`INSERT INTO runs (id, repo, subject_kind, subject_number, workflow, status)
			 VALUES ($1, 'o/r', 'issue', 200, 'triage', 'running')`,
			[runId],
		);

		// Use the store function indirectly via raw SQL to test transactional behavior
		const client = await pool.connect();
		try {
			await client.query("BEGIN");
			await client.query(
				`UPDATE runs SET status = 'completed', outcome = 'asked', completed_at = now() WHERE id = $1`,
				[runId],
			);
			await client.query(
				`INSERT INTO runs (id, repo, subject_kind, subject_number, workflow, status, previous_run_id)
				 VALUES ($1, 'o/r', 'issue', 200, 'triage', 'queued', $2)
				 ON CONFLICT DO NOTHING`,
				[followUpId, runId],
			);
			await client.query("COMMIT");

			const { rows } = await client.query(
				"SELECT id, status, previous_run_id FROM runs WHERE id IN ($1, $2) ORDER BY created_at",
				[runId, followUpId],
			);
			expect(rows).toHaveLength(2);
			expect(rows[0].status).toBe("completed");
			expect(rows[1].status).toBe("queued");
			expect(rows[1].previous_run_id).toBe(runId);
		} finally {
			client.release();
		}

		await pool.query("DELETE FROM runs WHERE id IN ($1, $2)", [runId, followUpId]);
	});
});

describe("concurrent claimForDispatch", () => {
	it("never double-claims the same run", async () => {
		const ids = Array.from({ length: 5 }, () => randomUUID());

		for (let i = 0; i < ids.length; i++) {
			await pool.query(
				`INSERT INTO runs (id, repo, subject_kind, subject_number, workflow, status)
				 VALUES ($1, 'o/r', 'issue', $2, 'spec-to-pr', 'queued')`,
				[ids[i], 300 + i],
			);
		}

		// Simulate concurrent dispatch claims
		const results = await Promise.all(
			Array.from({ length: 3 }, async () => {
				const client = await pool.connect();
				try {
					const { rows } = await client.query(
						`UPDATE runs SET status = 'dispatched', dispatched_at = now(),
						                 dispatch_attempts = dispatch_attempts + 1
						 WHERE id IN (
						   SELECT id FROM runs
						   WHERE status = 'queued'
						   ORDER BY created_at
						   FOR UPDATE SKIP LOCKED
						   LIMIT 3
						 )
						 RETURNING id`,
					);
					return rows.map((r: { id: string }) => r.id);
				} finally {
					client.release();
				}
			}),
		);

		// Flatten and verify no duplicates
		const allClaimed = results.flat();
		const unique = new Set(allClaimed);
		expect(allClaimed.length).toBe(unique.size);
		expect(allClaimed.length).toBe(5);

		for (const id of ids) {
			await pool.query("DELETE FROM runs WHERE id = $1", [id]);
		}
	});
});

describe("concurrent warm-sandbox claims", () => {
	it("never double-leases the same sandbox", async () => {
		const sbIds = Array.from({ length: 3 }, () => randomUUID());

		for (const id of sbIds) {
			await pool.query(
				`INSERT INTO sandboxes (id, status, ready_at) VALUES ($1, 'warm', now())`,
				[id],
			);
		}

		const results = await Promise.all(
			Array.from({ length: 5 }, async (_, i) => {
				const client = await pool.connect();
				try {
					const { rows } = await client.query(
						`UPDATE sandboxes SET status = 'leased', run_id = $1, leased_at = now()
						 WHERE id = (
						   SELECT id FROM sandboxes WHERE status = 'warm'
						   ORDER BY ready_at FOR UPDATE SKIP LOCKED LIMIT 1
						 )
						 RETURNING id`,
						[`run-${i}`],
					);
					return rows.map((r: { id: string }) => r.id);
				} finally {
					client.release();
				}
			}),
		);

		const allLeased = results.flat();
		const unique = new Set(allLeased);
		expect(allLeased.length).toBe(unique.size);
		expect(allLeased.length).toBe(3);

		for (const id of sbIds) {
			await pool.query("DELETE FROM sandboxes WHERE id = $1", [id]);
		}
	});
});

describe("artifact caps", () => {
	it("rejects an artifact exceeding per-artifact cap", async () => {
		const runId = randomUUID();
		await pool.query(
			`INSERT INTO runs (id, repo, subject_kind, subject_number, workflow, status)
			 VALUES ($1, 'o/r', 'issue', 400, 'spec-to-pr', 'running')`,
			[runId],
		);

		// Import the store function
		const { putArtifact } = await import("../../app/store/artifacts.js");

		const oversized = Buffer.alloc(6_000_000); // > 5 MB cap
		await expect(
			putArtifact({
				runId,
				kind: "log",
				contentType: "text/plain",
				bytes: oversized,
			}),
		).rejects.toThrow(/per-artifact cap/);

		await pool.query("DELETE FROM runs WHERE id = $1", [runId]);
	});

	it("rejects artifacts exceeding per-run cap", async () => {
		const runId = randomUUID();
		await pool.query(
			`INSERT INTO runs (id, repo, subject_kind, subject_number, workflow, status)
			 VALUES ($1, 'o/r', 'issue', 401, 'spec-to-pr', 'running')`,
			[runId],
		);

		const { putArtifact } = await import("../../app/store/artifacts.js");

		// Insert several artifacts approaching the 50 MB cap
		const chunk = Buffer.alloc(4_900_000);
		for (let i = 0; i < 10; i++) {
			await putArtifact({
				runId,
				kind: "log",
				contentType: "text/plain",
				bytes: chunk,
			});
		}

		// The next one should exceed the 50 MB per-run cap
		await expect(
			putArtifact({
				runId,
				kind: "log",
				contentType: "text/plain",
				bytes: chunk,
			}),
		).rejects.toThrow(/per-run artifact cap/);

		await pool.query("DELETE FROM artifacts WHERE run_id = $1", [runId]);
		await pool.query("DELETE FROM runs WHERE id = $1", [runId]);
	});
});
