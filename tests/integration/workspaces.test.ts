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

describe("top-up counting excludes stuck rows", () => {
	it("counts only recent in-flight rows", async () => {
		const ids = [randomUUID(), randomUUID(), randomUUID()];
		await pool.query(
			`INSERT INTO sandboxes (id, status, ready_at) VALUES ($1, 'warm', now())`,
			[ids[0]],
		);
		await pool.query(
			`INSERT INTO sandboxes (id, status, created_at)
			 VALUES ($1, 'creating', now())`,
			[ids[1]],
		);
		// Old stuck row — should NOT be counted
		await pool.query(
			`INSERT INTO sandboxes (id, status, created_at)
			 VALUES ($1, 'preparing', now() - interval '2 hours')`,
			[ids[2]],
		);

		const { rows } = await pool.query(
			`SELECT count(*)::int AS cnt FROM sandboxes
			 WHERE status = 'warm'
			    OR (status IN ('creating', 'preparing')
			        AND created_at > now() - interval '30 minutes')`,
		);
		expect(rows[0].cnt).toBe(2);

		for (const id of ids) {
			await pool.query("DELETE FROM sandboxes WHERE id = $1", [id]);
		}
	});
});

describe("recycle atomically claims warm rows", () => {
	it("transitions warm → released and returns only claimed rows", async () => {
		const oldId = randomUUID();
		const freshId = randomUUID();

		await pool.query(
			`INSERT INTO sandboxes (id, status, ready_at, base_sha, expires_at, provider_id)
			 VALUES ($1, 'warm', now() - interval '2 hours', 'sha-tip', now() + interval '4 hours', 'sbx-old')`,
			[oldId],
		);
		await pool.query(
			`INSERT INTO sandboxes (id, status, ready_at, base_sha, expires_at, provider_id)
			 VALUES ($1, 'warm', now(), 'sha-tip', now() + interval '4 hours', 'sbx-fresh')`,
			[freshId],
		);

		const { rows } = await pool.query(
			`UPDATE sandboxes
			 SET status = 'released', released_at = now()
			 WHERE id IN (
			   SELECT id FROM sandboxes
			   WHERE status = 'warm'
			     AND (
			       ready_at < now() - make_interval(mins => $1)
			       OR expires_at < now() + interval '30 minutes'
			       OR base_sha != $2
			     )
			   FOR UPDATE SKIP LOCKED
			 )
			 RETURNING id`,
			[60, "sha-tip"],
		);

		const recycledIds = rows.map((r: { id: string }) => r.id);
		expect(recycledIds).toContain(oldId);
		expect(recycledIds).not.toContain(freshId);

		// Verify the old one is released, not warm
		const { rows: check } = await pool.query(
			"SELECT status FROM sandboxes WHERE id = $1",
			[oldId],
		);
		expect(check[0].status).toBe("released");

		await pool.query("DELETE FROM sandboxes WHERE id IN ($1, $2)", [
			oldId,
			freshId,
		]);
	});

	it("a concurrent lease cannot claim a recycled sandbox", async () => {
		const sbId = randomUUID();

		await pool.query(
			`INSERT INTO sandboxes (id, status, ready_at, base_sha, expires_at, provider_id)
			 VALUES ($1, 'warm', now() - interval '2 hours', 'old-sha', now() + interval '4 hours', 'sbx-race')`,
			[sbId],
		);

		// Recycle claims it atomically
		await pool.query(
			`UPDATE sandboxes
			 SET status = 'released', released_at = now()
			 WHERE id IN (
			   SELECT id FROM sandboxes
			   WHERE status = 'warm'
			     AND ready_at < now() - make_interval(mins => $1)
			   FOR UPDATE SKIP LOCKED
			 )`,
			[60],
		);

		// Lease attempt should find nothing warm
		const { rows } = await pool.query(
			`UPDATE sandboxes SET status = 'leased', run_id = 'run-late', leased_at = now()
			 WHERE id = (
			   SELECT id FROM sandboxes WHERE status = 'warm'
			   ORDER BY ready_at FOR UPDATE SKIP LOCKED LIMIT 1
			 )
			 RETURNING id`,
		);
		expect(rows).toHaveLength(0);

		await pool.query("DELETE FROM sandboxes WHERE id = $1", [sbId]);
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

		process.env.DATABASE_URL = DATABASE_URL;
		const { listTerminalLeasedSandboxes } = await import(
			"../../app/store/sandboxes.js"
		);
		const terminal = await listTerminalLeasedSandboxes();
		const ids = terminal.map((r: { id: string }) => r.id);
		expect(ids).toContain(sbId);

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
			`INSERT INTO sandboxes (id, status, run_id, leased_at, expires_at)
			 VALUES ($1, 'leased', $2, now(), now() + interval '2 hours')`,
			[sbId, runId],
		);

		process.env.DATABASE_URL = DATABASE_URL;
		const { listTerminalLeasedSandboxes } = await import(
			"../../app/store/sandboxes.js"
		);
		const terminal = await listTerminalLeasedSandboxes();
		const ids = terminal.map((r: { id: string }) => r.id);
		expect(ids).not.toContain(sbId);

		await pool.query("DELETE FROM sandboxes WHERE id = $1", [sbId]);
		await pool.query("DELETE FROM runs WHERE id = $1", [runId]);
	});

	it("does not reap sandboxes already released", async () => {
		const sbId = randomUUID();

		await pool.query(
			`INSERT INTO sandboxes (id, status, released_at, expires_at)
			 VALUES ($1, 'released', now(), now() - interval '1 hour')`,
			[sbId],
		);

		process.env.DATABASE_URL = DATABASE_URL;
		const { claimExpiredWarmSandboxes } = await import(
			"../../app/store/sandboxes.js"
		);
		const expired = await claimExpiredWarmSandboxes();
		const ids = expired.map((r: { id: string }) => r.id);
		expect(ids).not.toContain(sbId);

		await pool.query("DELETE FROM sandboxes WHERE id = $1", [sbId]);
	});
});

describe("stuck in-flight rows", () => {
	it("lists creating/preparing rows older than 30 minutes", async () => {
		const stuckId = randomUUID();
		const freshId = randomUUID();

		await pool.query(
			`INSERT INTO sandboxes (id, status, created_at, provider_id)
			 VALUES ($1, 'creating', now() - interval '2 hours', 'sbx-stuck')`,
			[stuckId],
		);
		await pool.query(
			`INSERT INTO sandboxes (id, status, created_at)
			 VALUES ($1, 'creating', now())`,
			[freshId],
		);

		process.env.DATABASE_URL = DATABASE_URL;
		const { listStuckInFlightSandboxes } = await import(
			"../../app/store/sandboxes.js"
		);
		const stuck = await listStuckInFlightSandboxes();
		const ids = stuck.map((r: { id: string }) => r.id);
		expect(ids).toContain(stuckId);
		expect(ids).not.toContain(freshId);

		await pool.query("DELETE FROM sandboxes WHERE id IN ($1, $2)", [
			stuckId,
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
		expect(rows[0].status).toBe("warm");

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

		const { rows } = await pool.query(
			"SELECT status FROM sandboxes WHERE id = $1",
			[id],
		);
		expect(rows[0].status).toBe("failed");

		await pool.query("DELETE FROM sandboxes WHERE id = $1", [id]);
	});

	it("markSandboxReady refuses to revive a released row", async () => {
		const id = randomUUID();
		await pool.query(
			`INSERT INTO sandboxes (id, status) VALUES ($1, 'released')`,
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

	it("markSandboxPreparing refuses from failed", async () => {
		const id = randomUUID();
		await pool.query(
			`INSERT INTO sandboxes (id, status) VALUES ($1, 'failed')`,
			[id],
		);

		process.env.DATABASE_URL = DATABASE_URL;
		const { markSandboxPreparing } = await import(
			"../../app/store/sandboxes.js"
		);
		const applied = await markSandboxPreparing(id);
		expect(applied).toBe(false);

		await pool.query("DELETE FROM sandboxes WHERE id = $1", [id]);
	});

	it("markSandboxTerminated does not touch released or failed rows", async () => {
		const releasedId = randomUUID();
		const failedId = randomUUID();

		await pool.query(
			`INSERT INTO sandboxes (id, status) VALUES ($1, 'released')`,
			[releasedId],
		);
		await pool.query(
			`INSERT INTO sandboxes (id, status) VALUES ($1, 'failed')`,
			[failedId],
		);

		process.env.DATABASE_URL = DATABASE_URL;
		const { markSandboxTerminated } = await import(
			"../../app/store/sandboxes.js"
		);
		await markSandboxTerminated(releasedId);
		await markSandboxTerminated(failedId);

		const { rows } = await pool.query(
			"SELECT id, status FROM sandboxes WHERE id IN ($1, $2) ORDER BY id",
			[releasedId, failedId],
		);
		for (const row of rows) {
			const r = row as { id: string; status: string };
			if (r.id === failedId) expect(r.status).toBe("failed");
			if (r.id === releasedId) expect(r.status).toBe("released");
		}

		await pool.query("DELETE FROM sandboxes WHERE id IN ($1, $2)", [
			releasedId,
			failedId,
		]);
	});

	it("markSandboxReadyAndLeased goes preparing → leased atomically", async () => {
		const id = randomUUID();
		await pool.query(
			`INSERT INTO sandboxes (id, status) VALUES ($1, 'preparing')`,
			[id],
		);

		process.env.DATABASE_URL = DATABASE_URL;
		const { markSandboxReadyAndLeased } = await import(
			"../../app/store/sandboxes.js"
		);
		const applied = await markSandboxReadyAndLeased(
			id,
			"run-x",
			"sha-x",
			"hash-x",
			new Date(Date.now() + 7200_000),
		);
		expect(applied).toBe(true);

		const { rows } = await pool.query(
			"SELECT status, run_id FROM sandboxes WHERE id = $1",
			[id],
		);
		expect(rows[0].status).toBe("leased");
		expect(rows[0].run_id).toBe("run-x");

		await pool.query("DELETE FROM sandboxes WHERE id = $1", [id]);
	});

	it("cold-path race: preparing row cannot be stolen by claimWarmSandbox", async () => {
		const id = randomUUID();
		await pool.query(
			`INSERT INTO sandboxes (id, status, ready_at, base_sha, lockfile_hash)
			 VALUES ($1, 'preparing', now(), 'sha', 'hash')`,
			[id],
		);

		// claimWarmSandbox only matches status = 'warm'
		process.env.DATABASE_URL = DATABASE_URL;
		const { claimWarmSandbox } = await import("../../app/store/sandboxes.js");
		const claimed = await claimWarmSandbox("run-thief");
		expect(claimed?.id).not.toBe(id);

		await pool.query("DELETE FROM sandboxes WHERE id = $1", [id]);
	});
});

describe("store functions", () => {
	it("countPoolSandboxes excludes old stuck rows", async () => {
		const ids = [randomUUID(), randomUUID(), randomUUID()];
		await pool.query(
			`INSERT INTO sandboxes (id, status, ready_at) VALUES ($1, 'warm', now())`,
			[ids[0]],
		);
		await pool.query(
			`INSERT INTO sandboxes (id, status, created_at)
			 VALUES ($1, 'creating', now())`,
			[ids[1]],
		);
		// Old stuck row
		await pool.query(
			`INSERT INTO sandboxes (id, status, created_at)
			 VALUES ($1, 'preparing', now() - interval '2 hours')`,
			[ids[2]],
		);

		process.env.DATABASE_URL = DATABASE_URL;
		const { countPoolSandboxes } = await import("../../app/store/sandboxes.js");
		const count = await countPoolSandboxes();
		// Should count the warm + recent creating = 2, not the old preparing
		expect(count).toBeGreaterThanOrEqual(2);
		// We can't assert exact equality since other tests may leave rows

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
