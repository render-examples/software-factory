import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DATABASE_URL =
	process.env.DATABASE_URL ??
	"postgresql://postgres:postgres@localhost:55432/rf_m11";
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
		max: 10,
		application_name: "rf_m11_workspace_test",
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

describe("reaping run sandboxes whose run is terminal", () => {
	it("lists run sandboxes whose run completed", async () => {
		const runId = randomUUID();
		const sbId = randomUUID();

		await pool.query(
			`INSERT INTO runs (id, repo, subject_kind, subject_number, workflow, status)
			 VALUES ($1, 'o/r', 'issue', 800, 'spec-to-pr', 'completed')`,
			[runId],
		);
		await pool.query(
			`INSERT INTO sandboxes (id, status, run_id, role, ready_at)
			 VALUES ($1, 'ready', $2, 'run', now())`,
			[sbId, runId],
		);

		process.env.DATABASE_URL = DATABASE_URL;
		const { listReapableSandboxes } = await import(
			"../../app/store/sandboxes.js"
		);
		const reapable = await listReapableSandboxes(7200);
		const ids = reapable.map((r: { id: string }) => r.id);
		expect(ids).toContain(sbId);

		await pool.query("DELETE FROM sandboxes WHERE id = $1", [sbId]);
		await pool.query("DELETE FROM runs WHERE id = $1", [runId]);
	});

	it("does not reap sandboxes with running runs", async () => {
		const runId = randomUUID();
		const sbId = randomUUID();

		await pool.query(
			`INSERT INTO runs (id, repo, subject_kind, subject_number, workflow, status)
			 VALUES ($1, 'o/r', 'issue', 801, 'spec-to-pr', 'running')`,
			[runId],
		);
		await pool.query(
			`INSERT INTO sandboxes (id, status, run_id, role, expires_at)
			 VALUES ($1, 'ready', $2, 'run', now() + interval '2 hours')`,
			[sbId, runId],
		);

		process.env.DATABASE_URL = DATABASE_URL;
		const { listReapableSandboxes } = await import(
			"../../app/store/sandboxes.js"
		);
		const reapable = await listReapableSandboxes(7200);
		const ids = reapable.map((r: { id: string }) => r.id);
		expect(ids).not.toContain(sbId);

		await pool.query("DELETE FROM sandboxes WHERE id = $1", [sbId]);
		await pool.query("DELETE FROM runs WHERE id = $1", [runId]);
	});
});

describe("reaping expired sandboxes", () => {
	it("lists sandboxes past expires_at", async () => {
		const sbId = randomUUID();

		await pool.query(
			`INSERT INTO sandboxes (id, status, role, expires_at)
			 VALUES ($1, 'ready', 'run', now() - interval '1 hour')`,
			[sbId],
		);

		process.env.DATABASE_URL = DATABASE_URL;
		const { listReapableSandboxes } = await import(
			"../../app/store/sandboxes.js"
		);
		const reapable = await listReapableSandboxes(7200);
		const ids = reapable.map((r: { id: string }) => r.id);
		expect(ids).toContain(sbId);

		await pool.query("DELETE FROM sandboxes WHERE id = $1", [sbId]);
	});
});

describe("reaping stuck creating rows", () => {
	it("lists non-builder creating rows older than 30 minutes", async () => {
		const stuckId = randomUUID();
		const freshId = randomUUID();

		await pool.query(
			`INSERT INTO sandboxes (id, status, role, created_at, provider_id)
			 VALUES ($1, 'creating', 'run', now() - interval '2 hours', 'sbx-stuck')`,
			[stuckId],
		);
		await pool.query(
			`INSERT INTO sandboxes (id, status, role, created_at)
			 VALUES ($1, 'creating', 'run', now())`,
			[freshId],
		);

		process.env.DATABASE_URL = DATABASE_URL;
		const { listReapableSandboxes } = await import(
			"../../app/store/sandboxes.js"
		);
		const reapable = await listReapableSandboxes(7200);
		const ids = reapable.map((r: { id: string }) => r.id);
		expect(ids).toContain(stuckId);
		expect(ids).not.toContain(freshId);

		await pool.query("DELETE FROM sandboxes WHERE id IN ($1, $2)", [
			stuckId,
			freshId,
		]);
	});
});

describe("reaping stale builders", () => {
	it("lists builder rows older than the builder timeout", async () => {
		const staleId = randomUUID();
		const freshId = randomUUID();

		await pool.query(
			`INSERT INTO sandboxes (id, status, role, created_at, provider_id)
			 VALUES ($1, 'creating', 'builder', now() - interval '3 hours', 'sbx-stale')`,
			[staleId],
		);
		await pool.query(
			`INSERT INTO sandboxes (id, status, role, created_at)
			 VALUES ($1, 'creating', 'builder', now())`,
			[freshId],
		);

		process.env.DATABASE_URL = DATABASE_URL;
		const { listReapableSandboxes } = await import(
			"../../app/store/sandboxes.js"
		);
		const reapable = await listReapableSandboxes(7200);
		const ids = reapable.map((r: { id: string }) => r.id);
		expect(ids).toContain(staleId);
		expect(ids).not.toContain(freshId);

		await pool.query("DELETE FROM sandboxes WHERE id IN ($1, $2)", [
			staleId,
			freshId,
		]);
	});
});

describe("status transition guards", () => {
	it("markSandboxReady only transitions from preparing", async () => {
		const id = randomUUID();
		await pool.query(
			`INSERT INTO sandboxes (id, status) VALUES ($1, 'preparing')`,
			[id],
		);

		process.env.DATABASE_URL = DATABASE_URL;
		const { markSandboxReady } = await import("../../app/store/sandboxes.js");
		const applied = await markSandboxReady(
			id,
			"sha-abc",
			"hash-123",
			new Date(Date.now() + 7200_000),
		);
		expect(applied).toBe(true);

		const { rows } = await pool.query(
			"SELECT status FROM sandboxes WHERE id = $1",
			[id],
		);
		expect(rows[0].status).toBe("ready");

		await pool.query("DELETE FROM sandboxes WHERE id = $1", [id]);
	});

	it("markSandboxReady refuses to revive a failed row", async () => {
		const id = randomUUID();
		await pool.query(
			`INSERT INTO sandboxes (id, status) VALUES ($1, 'failed')`,
			[id],
		);

		process.env.DATABASE_URL = DATABASE_URL;
		const { markSandboxReady } = await import("../../app/store/sandboxes.js");
		const applied = await markSandboxReady(
			id,
			"sha",
			"hash",
			new Date(Date.now() + 7200_000),
		);
		expect(applied).toBe(false);

		await pool.query("DELETE FROM sandboxes WHERE id = $1", [id]);
	});

	it("markSandboxPreparing only transitions from creating", async () => {
		const id = randomUUID();
		await pool.query(
			`INSERT INTO sandboxes (id, status) VALUES ($1, 'creating')`,
			[id],
		);

		process.env.DATABASE_URL = DATABASE_URL;
		const { markSandboxPreparing } = await import(
			"../../app/store/sandboxes.js"
		);
		const applied = await markSandboxPreparing(id);
		expect(applied).toBe(true);

		const { rows } = await pool.query(
			"SELECT status FROM sandboxes WHERE id = $1",
			[id],
		);
		expect(rows[0].status).toBe("preparing");

		await pool.query("DELETE FROM sandboxes WHERE id = $1", [id]);
	});

	it("markSandboxTerminated does not touch terminated or failed rows", async () => {
		const terminatedId = randomUUID();
		const failedId = randomUUID();

		await pool.query(
			`INSERT INTO sandboxes (id, status) VALUES ($1, 'terminated')`,
			[terminatedId],
		);
		await pool.query(
			`INSERT INTO sandboxes (id, status) VALUES ($1, 'failed')`,
			[failedId],
		);

		process.env.DATABASE_URL = DATABASE_URL;
		const { markSandboxTerminated } = await import(
			"../../app/store/sandboxes.js"
		);
		await markSandboxTerminated(terminatedId);
		await markSandboxTerminated(failedId);

		const { rows } = await pool.query(
			"SELECT id, status FROM sandboxes WHERE id IN ($1, $2) ORDER BY id",
			[terminatedId, failedId],
		);
		for (const row of rows) {
			const r = row as { id: string; status: string };
			if (r.id === failedId) expect(r.status).toBe("failed");
			if (r.id === terminatedId) expect(r.status).toBe("terminated");
		}

		await pool.query("DELETE FROM sandboxes WHERE id IN ($1, $2)", [
			terminatedId,
			failedId,
		]);
	});
});

describe("store functions", () => {
	it("listSandboxesForRun returns non-terminal sandboxes for the run", async () => {
		const runId = randomUUID();
		const sbReady = randomUUID();
		const sbTerminated = randomUUID();

		await pool.query(
			`INSERT INTO sandboxes (id, status, run_id, role) VALUES ($1, 'ready', $2, 'run')`,
			[sbReady, runId],
		);
		await pool.query(
			`INSERT INTO sandboxes (id, status, run_id, role) VALUES ($1, 'terminated', $2, 'run')`,
			[sbTerminated, runId],
		);

		process.env.DATABASE_URL = DATABASE_URL;
		const { listSandboxesForRun } = await import(
			"../../app/store/sandboxes.js"
		);
		const sandboxes = await listSandboxesForRun(runId);
		expect(sandboxes).toHaveLength(1);
		expect(sandboxes[0].id).toBe(sbReady);

		await pool.query("DELETE FROM sandboxes WHERE id IN ($1, $2)", [
			sbReady,
			sbTerminated,
		]);
	});
});

describe("advisory lock", () => {
	it("second caller blocks until the first releases", async () => {
		const client1 = await pool.connect();
		const client2 = await pool.connect();

		try {
			const { rows: lock1 } = await client1.query(
				"SELECT pg_try_advisory_lock(83927) AS acquired",
			);
			expect(lock1[0].acquired).toBe(true);

			const { rows: lock2 } = await client2.query(
				"SELECT pg_try_advisory_lock(83927) AS acquired",
			);
			expect(lock2[0].acquired).toBe(false);

			await client1.query("SELECT pg_advisory_unlock(83927)");

			const { rows: lock3 } = await client2.query(
				"SELECT pg_try_advisory_lock(83927) AS acquired",
			);
			expect(lock3[0].acquired).toBe(true);
			await client2.query("SELECT pg_advisory_unlock(83927)");
		} finally {
			client1.release();
			client2.release();
		}
	});
});
