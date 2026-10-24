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

const { closeEvents, emit } = await import("../app/events/index.js");

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
