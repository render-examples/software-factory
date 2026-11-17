import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, type Db, migrate } from "../app/db/index.js";
import { AgentRunRecorder } from "../app/events/index.js";
import { createGateway, EventHub, listen } from "../app/gateway/index.js";
import { postgresDatabase, TEST_DATABASE_URL } from "./helpers/db.js";
import { readSse } from "./helpers/sse.js";

const TOKEN = "reader-token";
const at = new Date().toISOString();

describe.skipIf(!TEST_DATABASE_URL)("streams on Postgres", { timeout: 20_000 }, () => {
	let database: Awaited<ReturnType<typeof postgresDatabase>>;
	let db: Db;
	const pools: Db[] = [];
	const listeners: { stop(): Promise<void> }[] = [];

	/** A gateway instance with its own pool and, unless `deaf`, its own LISTEN connection. */
	function gateway({ deaf = false } = {}) {
		const hub = new EventHub();
		const pool = createDb(database.url, 2);
		pools.push(pool);
		if (!deaf) listeners.push(listen(hub, database.url));
		return createGateway({ startTask: async () => ({ id: "trn" }), webhookSecret: "secret", db: pool, hub, eventsReadToken: TOKEN });
	}
	const get = (app: ReturnType<typeof gateway>, path: string) => app.request(path, { headers: { authorization: `Bearer ${TOKEN}` } });

	beforeAll(async () => {
		database = await postgresDatabase();
		db = createDb(database.url, 3);
		await migrate(db);
	});
	afterAll(async () => {
		await Promise.all(listeners.map((listener) => listener.stop()));
		await Promise.all([db, ...pools].map((pool) => pool.end()));
		await database.drop();
	});

	async function untilListening(count: number): Promise<void> {
		await vi.waitFor(
			async () => {
				const { rows } = await db.query<{ n: number }>(
					"select count(*)::int as n from pg_stat_activity where datname = current_database() and query like 'listen events%'",
				);
				expect(rows[0]?.n).toBe(count);
			},
			{ timeout: 5000 },
		);
	}

	it("delivers the same deltas to readers on two gateway instances", async () => {
		const [a, b] = [gateway(), gateway()];
		await untilListening(2);
		const r = new AgentRunRecorder({ db, runId: "trn-1", thread: "github:acme/web#issue-5" });
		r.start({ agentId: "triage", harness: "pi", model: "anthropic/claude-opus-5" });
		const streams = [readSse(await get(a, `/agent-runs/${r.id}/stream`)), readSse(await get(b, "/threads/github/acme/web/issue/5/stream"))];
		for (const stream of streams) expect((await stream.next())?.event).toBe("agent_run.started");

		r.onRunnerEvent({ type: "assistant_delta", at, message_id: "m1", text: "Hello" });
		for (const stream of streams) expect(await stream.next()).toMatchObject({ event: "live.delta", data: { message_id: "m1", text: "Hello" } });
		r.onRunnerEvent({ type: "assistant_text", at, message_id: "m1", text: "Hello" });
		await r.finish({
			outcome: "ok",
			turns: 1,
			usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0 },
			costUsd: 0,
		});
		for (const stream of streams) expect((await stream.take(2)).map((f) => f.event)).toEqual(["assistant.message", "agent_run.finished"]);
		await Promise.all(streams.map((stream) => stream.close()));
	});

	it("catches up on a missed notification with the backstop poll", async () => {
		const app = gateway({ deaf: true });
		const r = new AgentRunRecorder({ db, runId: "trn-2", thread: "github:acme/web#issue-6" });
		const stream = readSse(await get(app, "/threads/github/acme/web/issue/6/stream"));
		r.start({ agentId: "triage", harness: "pi", model: "anthropic/claude-opus-5" });
		const started = Date.now();
		expect((await stream.next())?.event).toBe("agent_run.started");
		expect(Date.now() - started).toBeLessThan(7000);
		await stream.close();
	});
});
