import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DATABASE_URL =
	process.env.DATABASE_URL ??
	"postgresql://postgres:postgres@localhost:55432/rf_m9";
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
		application_name: "rf_m9_test",
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

describe("listRuns", () => {
	it("returns runs newest-first with filters", async () => {
		const id1 = randomUUID();
		const id2 = randomUUID();
		const id3 = randomUUID();

		await pool.query(
			`INSERT INTO runs (id, repo, subject_kind, subject_number, workflow, status, created_at)
			 VALUES ($1, 'o/r', 'issue', 1, 'triage', 'completed', now() - interval '2 hours')`,
			[id1],
		);
		await pool.query(
			`INSERT INTO runs (id, repo, subject_kind, subject_number, workflow, status, created_at)
			 VALUES ($1, 'o/r', 'issue', 2, 'spec-to-pr', 'running', now() - interval '1 hour')`,
			[id2],
		);
		await pool.query(
			`INSERT INTO runs (id, repo, subject_kind, subject_number, workflow, status, created_at)
			 VALUES ($1, 'o/r', 'issue', 3, 'triage', 'queued', now())`,
			[id3],
		);

		const { listRuns } = await import("../../app/store/queries.js");

		const all = await listRuns({});
		expect(all.length).toBeGreaterThanOrEqual(3);
		const ids = all.map((r: { id: string }) => r.id);
		expect(ids.indexOf(id3)).toBeLessThan(ids.indexOf(id2));
		expect(ids.indexOf(id2)).toBeLessThan(ids.indexOf(id1));

		const triageOnly = await listRuns({ workflow: "triage" });
		const triageIds = triageOnly.map((r: { id: string }) => r.id);
		expect(triageIds).toContain(id1);
		expect(triageIds).toContain(id3);
		expect(triageIds).not.toContain(id2);

		const limited = await listRuns({ limit: 1 });
		expect(limited).toHaveLength(1);

		for (const id of [id1, id2, id3]) {
			await pool.query("DELETE FROM runs WHERE id = $1", [id]);
		}
	});
});

describe("listConversation", () => {
	it("walks the previous_run_id chain both ways", async () => {
		const r1 = randomUUID();
		const r2 = randomUUID();
		const r3 = randomUUID();

		await pool.query(
			`INSERT INTO runs (id, repo, subject_kind, subject_number, workflow, status, created_at)
			 VALUES ($1, 'o/r', 'issue', 10, 'triage', 'completed', now() - interval '3 hours')`,
			[r1],
		);
		await pool.query(
			`INSERT INTO runs (id, repo, subject_kind, subject_number, workflow, status, previous_run_id, created_at)
			 VALUES ($1, 'o/r', 'issue', 10, 'triage', 'completed', $2, now() - interval '2 hours')`,
			[r2, r1],
		);
		await pool.query(
			`INSERT INTO runs (id, repo, subject_kind, subject_number, workflow, status, previous_run_id, created_at)
			 VALUES ($1, 'o/r', 'issue', 10, 'spec-to-pr', 'completed', $2, now() - interval '1 hour')`,
			[r3, r2],
		);

		const { listConversation } = await import("../../app/store/queries.js");

		const conv = await listConversation(r2);
		const convIds = conv.map((r: { id: string }) => r.id);
		expect(convIds).toContain(r1);
		expect(convIds).toContain(r2);
		expect(convIds).toContain(r3);
		expect(convIds.indexOf(r1)).toBeLessThan(convIds.indexOf(r2));
		expect(convIds.indexOf(r2)).toBeLessThan(convIds.indexOf(r3));

		for (const id of [r3, r2, r1]) {
			await pool.query("DELETE FROM runs WHERE id = $1", [id]);
		}
	});
});

describe("listArtifactsByRun", () => {
	it("returns metadata without bytes or link_token_hash", async () => {
		const runId = randomUUID();
		const artId = randomUUID();

		await pool.query(
			`INSERT INTO runs (id, repo, subject_kind, subject_number, workflow, status)
			 VALUES ($1, 'o/r', 'issue', 20, 'triage', 'running')`,
			[runId],
		);
		const tokenHash = createHash("sha256").update("secret-token").digest("hex");
		await pool.query(
			`INSERT INTO artifacts (id, run_id, kind, content_type, bytes, size, sha256, link_token_hash, expires_at)
			 VALUES ($1, $2, 'screenshot', 'image/png', $3, 4, 'abc', $4, now() + interval '1 day')`,
			[artId, runId, Buffer.from("test"), tokenHash],
		);

		const { listArtifactsByRun } = await import("../../app/store/queries.js");
		const arts = await listArtifactsByRun(runId);

		expect(arts).toHaveLength(1);
		expect(arts[0].id).toBe(artId);
		expect(arts[0].linkTokenHash).toBeNull();
		expect(arts[0]).not.toHaveProperty("bytes");

		await pool.query("DELETE FROM artifacts WHERE id = $1", [artId]);
		await pool.query("DELETE FROM runs WHERE id = $1", [runId]);
	});
});

describe("listDeliveries", () => {
	it("returns recent deliveries newest first", async () => {
		const d1 = `del-${randomUUID().slice(0, 8)}`;
		const d2 = `del-${randomUUID().slice(0, 8)}`;

		await pool.query(
			`INSERT INTO deliveries (delivery_id, event, action, outcome, received_at)
			 VALUES ($1, 'issues', 'labeled', 'accepted', now() - interval '1 hour')`,
			[d1],
		);
		await pool.query(
			`INSERT INTO deliveries (delivery_id, event, action, outcome, received_at)
			 VALUES ($1, 'issue_comment', 'created', 'ignored', now())`,
			[d2],
		);

		const { listDeliveries } = await import("../../app/store/queries.js");
		const result = await listDeliveries(10);
		const ids = result.map((d: { deliveryId: string }) => d.deliveryId);
		expect(ids.indexOf(d2)).toBeLessThan(ids.indexOf(d1));

		await pool.query("DELETE FROM deliveries WHERE delivery_id IN ($1, $2)", [
			d1,
			d2,
		]);
	});
});

describe("listSpecVersions", () => {
	it("returns versions in ascending order", async () => {
		const specId = randomUUID();

		await pool.query(
			`INSERT INTO specs (id, repo, issue_number, status, current_version)
			 VALUES ($1, 'o/r', 30, 'draft', 2)`,
			[specId],
		);
		await pool.query(
			`INSERT INTO spec_versions (spec_id, version, document, markdown)
			 VALUES ($1, 1, '{"title":"v1"}'::jsonb, '# v1'),
			        ($1, 2, '{"title":"v2"}'::jsonb, '# v2')`,
			[specId],
		);

		const { listSpecVersions } = await import("../../app/store/queries.js");
		const versions = await listSpecVersions(specId);
		expect(versions).toHaveLength(2);
		expect(versions[0].version).toBe(1);
		expect(versions[1].version).toBe(2);

		await pool.query("DELETE FROM spec_versions WHERE spec_id = $1", [specId]);
		await pool.query("DELETE FROM specs WHERE id = $1", [specId]);
	});
});

describe("listEventsByRun", () => {
	it("returns events ordered by id", async () => {
		const runId = randomUUID();
		await pool.query(
			`INSERT INTO runs (id, repo, subject_kind, subject_number, workflow, status)
			 VALUES ($1, 'o/r', 'issue', 40, 'triage', 'running')`,
			[runId],
		);

		await pool.query(
			`INSERT INTO run_events (run_id, type, span_id, phase)
			 VALUES ($1, 'stage', 'span-1', 'start'),
			        ($1, 'agent.cost', 'span-2', 'point'),
			        ($1, 'stage', 'span-1', 'end')`,
			[runId],
		);

		const { listEventsByRun } = await import("../../app/store/queries.js");
		const events = await listEventsByRun(runId);
		expect(events.length).toBeGreaterThanOrEqual(3);
		const ids = events.map((e: { id: string }) => Number(e.id));
		for (let i = 1; i < ids.length; i++) {
			expect(ids[i]).toBeGreaterThan(ids[i - 1]);
		}

		await pool.query("DELETE FROM run_events WHERE run_id = $1", [runId]);
		await pool.query("DELETE FROM runs WHERE id = $1", [runId]);
	});
});

describe("getArtifactForServing", () => {
	it("returns bytes for a non-expired artifact", async () => {
		const runId = randomUUID();
		const artId = randomUUID();

		await pool.query(
			`INSERT INTO runs (id, repo, subject_kind, subject_number, workflow, status)
			 VALUES ($1, 'o/r', 'issue', 50, 'triage', 'running')`,
			[runId],
		);
		await pool.query(
			`INSERT INTO artifacts (id, run_id, kind, content_type, bytes, size, sha256, expires_at)
			 VALUES ($1, $2, 'log', 'text/plain', $3, 11, 'abc', now() + interval '1 day')`,
			[artId, runId, Buffer.from("hello world")],
		);

		const { getArtifactForServing } = await import(
			"../../app/store/queries.js"
		);
		const result = await getArtifactForServing(artId);
		expect(result).not.toBeNull();
		expect(result?.contentType).toBe("text/plain");
		expect(result?.bytes.toString()).toBe("hello world");

		await pool.query("DELETE FROM artifacts WHERE id = $1", [artId]);
		await pool.query("DELETE FROM runs WHERE id = $1", [runId]);
	});

	it("returns null for an expired artifact", async () => {
		const runId = randomUUID();
		const artId = randomUUID();

		await pool.query(
			`INSERT INTO runs (id, repo, subject_kind, subject_number, workflow, status)
			 VALUES ($1, 'o/r', 'issue', 51, 'triage', 'running')`,
			[runId],
		);
		await pool.query(
			`INSERT INTO artifacts (id, run_id, kind, content_type, bytes, size, sha256, expires_at)
			 VALUES ($1, $2, 'log', 'text/plain', $3, 5, 'abc', now() - interval '1 day')`,
			[artId, runId, Buffer.from("stale")],
		);

		const { getArtifactForServing } = await import(
			"../../app/store/queries.js"
		);
		const result = await getArtifactForServing(artId);
		expect(result).toBeNull();

		await pool.query("DELETE FROM artifacts WHERE id = $1", [artId]);
		await pool.query("DELETE FROM runs WHERE id = $1", [runId]);
	});
});
