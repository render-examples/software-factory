import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pg = vi.hoisted(() => ({
	query: vi.fn(),
	end: vi.fn(async () => {}),
	constructed: 0,
}));

vi.mock("pg", () => {
	class Pool {
		constructor() {
			pg.constructed++;
		}
		query = pg.query;
		end = pg.end;
		on() {
			return this;
		}
	}
	return { default: { Pool } };
});

const { claimRun, closeEvents, emit, isCurrentRun } = await import("../app/events/index.js");

const event = { traceId: "trn-1", type: "run.started", repo: "acme/web", payload: { a: 1 } };

beforeEach(() => {
	pg.query.mockReset();
	pg.constructed = 0;
});

afterEach(async () => {
	await closeEvents();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe("emit", () => {
	it("swallows database errors and logs one JSON warning", async () => {
		vi.stubEnv("DATABASE_URL", "postgres://fake/db");
		pg.query.mockRejectedValueOnce(new Error("connection refused"));
		const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
		await expect(emit(event)).resolves.toBeUndefined();
		expect(stderr).toHaveBeenCalledTimes(1);
		expect(JSON.parse(stderr.mock.calls[0]?.[0] as string)).toMatchObject({
			level: "warn",
			msg: "event dropped",
			type: "run.started",
			error: "connection refused",
		});
	});
});

describe("run coordination", () => {
	const input = {
		traceId: "trn-root",
		runId: "trn-2",
		repo: "acme/web",
		subject: "issue#12",
		stage: "triage",
		actor: "alice",
	};

	it("fails closed when Postgres is unavailable", async () => {
		delete process.env.DATABASE_URL;
		await expect(claimRun(input)).rejects.toThrow("DATABASE_URL is not set");
	});

	it("appends a strict claim and returns its fencing token", async () => {
		vi.stubEnv("DATABASE_URL", "postgres://fake/db");
		pg.query.mockResolvedValueOnce({ rows: [{ id: "42" }] });
		await expect(claimRun(input)).resolves.toEqual({
			id: "42",
			runId: "trn-2",
			repo: "acme/web",
			subject: "issue#12",
		});
		const [sql, params] = pg.query.mock.calls[0] as [string, unknown[]];
		expect(sql).toMatch(/insert into events/);
		expect(sql).toContain("'run.claimed'");
		expect(params).toEqual(["trn-root", "trn-2", "acme/web", "issue#12", JSON.stringify({ stage: "triage", actor: "alice" })]);
	});

	it("checks the claim against the latest claim for its subject", async () => {
		vi.stubEnv("DATABASE_URL", "postgres://fake/db");
		const claim = { id: "42", runId: "trn-2", repo: "acme/web", subject: "issue#12" };
		pg.query.mockResolvedValueOnce({ rows: [{ id: "42" }] });
		await expect(isCurrentRun(claim)).resolves.toBe(true);
		pg.query.mockResolvedValueOnce({ rows: [{ id: "43" }] });
		await expect(isCurrentRun(claim)).resolves.toBe(false);
	});

	it("propagates database failures", async () => {
		vi.stubEnv("DATABASE_URL", "postgres://fake/db");
		pg.query.mockRejectedValueOnce(new Error("connection refused"));
		await expect(claimRun(input)).rejects.toThrow("connection refused");
	});
});
