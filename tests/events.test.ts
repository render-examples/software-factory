import { afterEach, describe, expect, it, vi } from "vitest";
import { emit } from "../app/events/index.js";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("emit", () => {
	it("writes one JSON line to stdout with the event name, its ids, and its payload", () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		emit({
			traceId: "trn-root",
			runId: "trn-2",
			repo: "acme/web",
			subject: "issue#12",
			type: "run.finished",
			payload: { stage: "triage", state: "done", outcome: "drafted" },
		});
		expect(log).toHaveBeenCalledTimes(1);
		expect(JSON.parse(log.mock.calls[0]?.[0] as string)).toEqual({
			level: "info",
			event: "run.finished",
			traceId: "trn-root",
			runId: "trn-2",
			repo: "acme/web",
			subject: "issue#12",
			stage: "triage",
			state: "done",
			outcome: "drafted",
		});
	});

	it("never throws, even when the payload can't be serialized", () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const warn = vi.spyOn(console, "error").mockImplementation(() => {});
		expect(() => emit({ traceId: "trn-1", type: "agent.finished", payload: { cost: 1n } })).not.toThrow();
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("event dropped"));
	});
});
