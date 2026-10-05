import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DATABASE_URL =
	process.env.DATABASE_URL ??
	"postgresql://postgres:postgres@localhost:55432/rf_m4";
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
		application_name: "rf_m4_workspace_test",
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

describe("concurrent warm-sandbox claims never double-lease", () => {
	it("5 concurrent claims on 3 warm sandboxes yield exactly 3 leases", async () => {
		const sbIds = Array.from({ length: 3 }, () => randomUUID());

		for (const id of sbIds) {
			await pool.query(
				`INSERT INTO sandboxes (id, status, ready_at, base_sha, lockfile_hash)
				 VALUES ($1, 'warm', now(), 'sha-x', 'hash-x')`,
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
						[`run-conc-${i}`],
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

describe("top-up counting in-flight rows", () => {
	it("counts creating/preparing/warm statuses together", async () => {
		const ids = [randomUUID(), randomUUID(), randomUUID()];
		await pool.query(
			`INSERT INTO sandboxes (id, status, ready_at) VALUES ($1, 'warm', now())`,
			[ids[0]],
		);
		await pool.query(
			`INSERT INTO sandboxes (id, status) VALUES ($1, 'creating')`,
			[ids[1]],
		);
		await pool.query(
			`INSERT INTO sandboxes (id, status) VALUES ($1, 'preparing')`,
			[ids[2]],
		);

		const { rows } = await pool.query(
			`SELECT count(*)::int AS cnt FROM sandboxes
			 WHERE status = ANY($1)`,
			[["warm", "creating", "preparing"]],
		);
		expect(rows[0].cnt).toBe(3);

		for (const id of ids) {
			await pool.query("DELETE FROM sandboxes WHERE id = $1", [id]);
		}
	});
});

describe("recycle selection", () => {
	it("selects warm sandboxes older than max age", async () => {
		const oldId = randomUUID();
		const freshId = randomUUID();

		await pool.query(
			`INSERT INTO sandboxes (id, status, ready_at, base_sha, expires_at)
			 VALUES ($1, 'warm', now() - interval '2 hours', 'sha-tip', now() + interval '4 hours')`,
			[oldId],
		);
		await pool.query(
			`INSERT INTO sandboxes (id, status, ready_at, base_sha, expires_at)
			 VALUES ($1, 'warm', now(), 'sha-tip', now() + interval '4 hours')`,
			[freshId],
		);

		const { rows } = await pool.query(
			`SELECT id FROM sandboxes
			 WHERE status = 'warm'
			   AND (
			     ready_at < now() - make_interval(mins => $1)
			     OR expires_at < now() + interval '30 minutes'
			     OR base_sha != $2
			   )`,
			[60, "sha-tip"],
		);

		const recycledIds = rows.map((r: { id: string }) => r.id);
		expect(recycledIds).toContain(oldId);
		expect(recycledIds).not.toContain(freshId);

		await pool.query("DELETE FROM sandboxes WHERE id IN ($1, $2)", [
			oldId,
			freshId,
		]);
	});

	it("selects warm sandboxes with stale base_sha", async () => {
		const staleId = randomUUID();

		await pool.query(
			`INSERT INTO sandboxes (id, status, ready_at, base_sha, expires_at)
			 VALUES ($1, 'warm', now(), 'old-sha', now() + interval '4 hours')`,
			[staleId],
		);

		const { rows } = await pool.query(
			`SELECT id FROM sandboxes
			 WHERE status = 'warm'
			   AND (
			     ready_at < now() - make_interval(mins => $1)
			     OR expires_at < now() + interval '30 minutes'
			     OR base_sha != $2
			   )`,
			[60, "new-tip-sha"],
		);

		const recycledIds = rows.map((r: { id: string }) => r.id);
		expect(recycledIds).toContain(staleId);

		await pool.query("DELETE FROM sandboxes WHERE id = $1", [staleId]);
	});
});

describe("reaping only recorded/terminal rows", () => {
	it("reaps leased sandboxes whose run is terminal", async () => {
		const runId = randomUUID();
		const sbId = randomUUID();

		await pool.query(
			`INSERT INTO runs (id, repo, subject_kind, subject_number, workflow, status)
			 VALUES ($1, 'o/r', 'issue', 800, 'spec-to-pr', 'completed')`,
			[runId],
		);
		await pool.query(
			`INSERT INTO sandboxes (id, status, run_id, leased_at)
			 VALUES ($1, 'leased', $2, now())`,
			[sbId, runId],
		);

		const { rows } = await pool.query(
			`SELECT s.id FROM sandboxes s
			 WHERE (s.status NOT IN ('released', 'failed') AND s.expires_at < now())
			    OR (s.status = 'leased' AND s.run_id IS NOT NULL AND EXISTS (
			          SELECT 1 FROM runs r
			          WHERE r.id = s.run_id
			            AND r.status IN ('completed', 'failed', 'cancelled')
			        ))`,
		);
		const reapIds = rows.map((r: { id: string }) => r.id);
		expect(reapIds).toContain(sbId);

		await pool.query("DELETE FROM sandboxes WHERE id = $1", [sbId]);
		await pool.query("DELETE FROM runs WHERE id = $1", [runId]);
	});

	it("does not reap leased sandboxes with running runs", async () => {
		const runId = randomUUID();
		const sbId = randomUUID();

		await pool.query(
			`INSERT INTO runs (id, repo, subject_kind, subject_number, workflow, status)
			 VALUES ($1, 'o/r', 'issue', 801, 'spec-to-pr', 'running')`,
			[runId],
		);
		await pool.query(
			`INSERT INTO sandboxes (id, status, run_id, leased_at,
			   expires_at)
			 VALUES ($1, 'leased', $2, now(), now() + interval '2 hours')`,
			[sbId, runId],
		);

		const { rows } = await pool.query(
			`SELECT s.id FROM sandboxes s
			 WHERE (s.status NOT IN ('released', 'failed') AND s.expires_at < now())
			    OR (s.status = 'leased' AND s.run_id IS NOT NULL AND EXISTS (
			          SELECT 1 FROM runs r
			          WHERE r.id = s.run_id
			            AND r.status IN ('completed', 'failed', 'cancelled')
			        ))`,
		);
		const reapIds = rows.map((r: { id: string }) => r.id);
		expect(reapIds).not.toContain(sbId);

		await pool.query("DELETE FROM sandboxes WHERE id = $1", [sbId]);
		await pool.query("DELETE FROM runs WHERE id = $1", [runId]);
	});

	it("reaps expired sandboxes regardless of run status", async () => {
		const sbId = randomUUID();

		await pool.query(
			`INSERT INTO sandboxes (id, status, expires_at)
			 VALUES ($1, 'warm', now() - interval '1 hour')`,
			[sbId],
		);

		const { rows } = await pool.query(
			`SELECT s.id FROM sandboxes s
			 WHERE (s.status NOT IN ('released', 'failed') AND s.expires_at < now())
			    OR (s.status = 'leased' AND s.run_id IS NOT NULL AND EXISTS (
			          SELECT 1 FROM runs r
			          WHERE r.id = s.run_id
			            AND r.status IN ('completed', 'failed', 'cancelled')
			        ))`,
		);
		const reapIds = rows.map((r: { id: string }) => r.id);
		expect(reapIds).toContain(sbId);

		await pool.query("DELETE FROM sandboxes WHERE id = $1", [sbId]);
	});

	it("does not reap sandboxes already released", async () => {
		const sbId = randomUUID();

		await pool.query(
			`INSERT INTO sandboxes (id, status, released_at, expires_at)
			 VALUES ($1, 'released', now(), now() - interval '1 hour')`,
			[sbId],
		);

		const { rows } = await pool.query(
			`SELECT s.id FROM sandboxes s
			 WHERE (s.status NOT IN ('released', 'failed') AND s.expires_at < now())
			    OR (s.status = 'leased' AND s.run_id IS NOT NULL AND EXISTS (
			          SELECT 1 FROM runs r
			          WHERE r.id = s.run_id
			            AND r.status IN ('completed', 'failed', 'cancelled')
			        ))`,
		);
		const reapIds = rows.map((r: { id: string }) => r.id);
		expect(reapIds).not.toContain(sbId);

		await pool.query("DELETE FROM sandboxes WHERE id = $1", [sbId]);
	});
});

describe("store functions", () => {
	it("markSandboxReady transitions from creating to warm", async () => {
		const id = randomUUID();
		await pool.query(
			`INSERT INTO sandboxes (id, status) VALUES ($1, 'creating')`,
			[id],
		);

		// Use the actual store function
		process.env.DATABASE_URL = DATABASE_URL;
		const { markSandboxReady } = await import("../../app/store/sandboxes.js");
		await markSandboxReady(
			id,
			"sha-abc",
			"hash-123",
			new Date(Date.now() + 7200_000),
		);

		const { rows } = await pool.query(
			"SELECT status, base_sha, lockfile_hash FROM sandboxes WHERE id = $1",
			[id],
		);
		expect(rows[0].status).toBe("warm");
		expect(rows[0].base_sha).toBe("sha-abc");
		expect(rows[0].lockfile_hash).toBe("hash-123");

		await pool.query("DELETE FROM sandboxes WHERE id = $1", [id]);
	});

	it("markSandboxFailed transitions to failed", async () => {
		const id = randomUUID();
		await pool.query(
			`INSERT INTO sandboxes (id, status) VALUES ($1, 'creating')`,
			[id],
		);

		process.env.DATABASE_URL = DATABASE_URL;
		const { markSandboxFailed } = await import("../../app/store/sandboxes.js");
		await markSandboxFailed(id);

		const { rows } = await pool.query(
			"SELECT status FROM sandboxes WHERE id = $1",
			[id],
		);
		expect(rows[0].status).toBe("failed");

		await pool.query("DELETE FROM sandboxes WHERE id = $1", [id]);
	});

	it("countSandboxesByStatus returns correct count", async () => {
		const ids = [randomUUID(), randomUUID(), randomUUID()];
		await pool.query(`INSERT INTO sandboxes (id, status) VALUES ($1, 'warm')`, [
			ids[0],
		]);
		await pool.query(
			`INSERT INTO sandboxes (id, status) VALUES ($1, 'creating')`,
			[ids[1]],
		);
		await pool.query(
			`INSERT INTO sandboxes (id, status) VALUES ($1, 'leased')`,
			[ids[2]],
		);

		process.env.DATABASE_URL = DATABASE_URL;
		const { countSandboxesByStatus } = await import(
			"../../app/store/sandboxes.js"
		);
		const count = await countSandboxesByStatus([
			"warm",
			"creating",
			"preparing",
		]);
		expect(count).toBeGreaterThanOrEqual(2);

		for (const id of ids) {
			await pool.query("DELETE FROM sandboxes WHERE id = $1", [id]);
		}
	});

	it("listSandboxesForRun returns only leased sandboxes for the run", async () => {
		const runId = randomUUID();
		const sbLeased = randomUUID();
		const sbOther = randomUUID();

		await pool.query(
			`INSERT INTO sandboxes (id, status, run_id) VALUES ($1, 'leased', $2)`,
			[sbLeased, runId],
		);
		await pool.query(
			`INSERT INTO sandboxes (id, status, run_id) VALUES ($1, 'released', $2)`,
			[sbOther, runId],
		);

		process.env.DATABASE_URL = DATABASE_URL;
		const { listSandboxesForRun } = await import(
			"../../app/store/sandboxes.js"
		);
		const sandboxes = await listSandboxesForRun(runId);
		expect(sandboxes).toHaveLength(1);
		expect(sandboxes[0].id).toBe(sbLeased);

		await pool.query("DELETE FROM sandboxes WHERE id IN ($1, $2)", [
			sbLeased,
			sbOther,
		]);
	});
});
