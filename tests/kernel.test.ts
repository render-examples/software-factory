import { describe, expect, it } from "vitest";
import { type Driver, type DriverContext, InvalidInput } from "../app/runner/core/driver.js";
import { createEmitter } from "../app/runner/core/emit.js";
import { executeHarness } from "../app/runner/core/kernel.js";
import type { RunnerInput } from "../app/runner/core/protocol.js";
import { GOOD, makeInput, makeWorkspace, parseEvents, terminal, toolResults } from "./helpers/runner.js";

const BAD = { summary: "x", files: "README.md" };

/** A driver whose conversation is `converse`, run with the kernel's context. */
const driver = (converse: (ctx: DriverContext) => Promise<void>): Driver => ({
	open: (ctx) => ({ version: "1.2.3", model: "fake-model", run: () => converse(ctx) }),
});

const aborted = (ctx: DriverContext) => new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve(), { once: true }));

async function execute(harness: Driver, input: RunnerInput = makeInput(undefined), signal?: AbortSignal) {
	let stdout = "";
	const emit = createEmitter(async (chunk) => {
		stdout += chunk;
	});
	const code = await executeHarness({ input, emit, apiKey: "sk-test", startedAt: Date.now(), signal }, { name: "fake", driver: harness });
	const events = async () => {
		await emit.flush();
		return parseEvents(stdout);
	};
	return { code, events: await events(), later: events };
}

describe("kernel", { timeout: 15_000 }, () => {
	// Assertions run outside the driver: once the outcome is decided, the kernel ignores how the driver settles.
	it("starts with the driver's version and model, and ends with the accepted submission and the model requests made", async () => {
		const seen: unknown[] = [];
		const { code, events } = await execute(
			driver(async (ctx) => {
				seen.push(ctx.requestModel());
				ctx.report.toolCall("c1", ctx.submit.name, BAD);
				ctx.report.toolResult("c1", ctx.submit.name, ctx.submit.call(BAD).text, true);
				seen.push(ctx.requestModel());
				ctx.report.toolCall("c2", ctx.submit.name, GOOD);
				const out = ctx.submit.call(GOOD);
				ctx.report.toolResult("c2", ctx.submit.name, out.text, out.isError);
				seen.push(ctx.submit.call({ ...GOOD, summary: "Another." }), ctx.requestModel());
			}),
		);
		expect(seen).toEqual([true, true, { isError: false, text: expect.stringContaining("Already submitted") }, false]);
		expect(events[0]).toMatchObject({ type: "started", agent_id: "test-agent", harness: "fake", harness_version: "1.2.3", model: "fake-model" });
		const [rejected, accepted] = toolResults(events);
		expect(rejected).toMatchObject({ is_error: true, output_preview: expect.stringContaining("attempt 1 of 3") });
		expect(accepted).toMatchObject({ is_error: false });
		expect(terminal(events)).toEqual(expect.objectContaining({ type: "result", output: GOOD, turns: 2 }));
		expect(code).toBe(0);
	});

	it("fails with invalid_input, without starting, when the driver can't run the configuration", async () => {
		const invalid = await execute({
			open: () => {
				throw new InvalidInput("unknown model");
			},
		});
		expect(invalid.events).toEqual([expect.objectContaining({ type: "error", code: "invalid_input", message: "unknown model" })]);
		expect(invalid.code).toBe(2);

		const broken = await execute({ open: () => Promise.reject(new Error("no library")) });
		expect(broken.events).toEqual([expect.objectContaining({ type: "error", code: "agent_error", message: "no library" })]);
		expect(broken.code).toBe(1);
	});

	it("ends with invalid_submission and stops the driver after the last rejected submission", async () => {
		const seen: unknown[] = [];
		const { code, events } = await execute(
			driver(async (ctx) => {
				for (let i = 0; i < 3; i++) ctx.submit.call(BAD);
				seen.push(ctx.signal.aborted, ctx.requestModel(), ctx.submit.call(GOOD));
			}),
		);
		expect(seen).toEqual([true, false, { text: "The run is over.", isError: true }]);
		expect(terminal(events)).toMatchObject({ type: "error", code: "invalid_submission", message: expect.stringContaining("rejected 3 times") });
		expect(code).toBe(1);
	});

	it("refuses the model request past max_turns and stops the driver", async () => {
		const seen: unknown[] = [];
		const { code, events } = await execute(
			driver(async (ctx) => {
				seen.push(ctx.requestModel(), ctx.requestModel(), ctx.requestModel(), ctx.signal.aborted);
			}),
			makeInput(undefined, { max_turns: 2 }),
		);
		expect(seen).toEqual([true, true, false, true]);
		expect(terminal(events)).toMatchObject({ type: "error", code: "max_turns", message: expect.stringContaining("turn limit (2)") });
		expect(code).toBe(1);
	});

	it("reports no_submission when the model stops, and the driver's failure when the library fails", async () => {
		const stopped = await execute(driver(async () => {}));
		expect(terminal(stopped.events)).toMatchObject({ type: "error", code: "no_submission", message: "the model stopped without calling submit" });

		const failed = await execute(driver(() => Promise.reject(new Error("boom"))));
		expect(terminal(failed.events)).toMatchObject({ type: "error", code: "agent_error", message: "boom" });
		expect(failed.code).toBe(1);
	});

	it("keeps the first outcome: a failure after an accepted submission still ends with the result", async () => {
		const { code, events } = await execute(
			driver(async (ctx) => {
				ctx.submit.call(GOOD);
				throw new Error("late failure");
			}),
		);
		expect(terminal(events)).toMatchObject({ type: "result", output: GOOD });
		expect(code).toBe(0);
	});

	it("times out with the budget left after the safety margin, and refuses a later submission", async () => {
		let late: unknown;
		const { code, events } = await execute(
			driver(async (ctx) => {
				await aborted(ctx);
				late = ctx.submit.call(GOOD);
			}),
			makeInput(undefined, { timeout_ms: 1000 }),
		);
		expect(late).toEqual({ text: "The run is over.", isError: true });
		expect(terminal(events)).toMatchObject({ type: "error", code: "timeout", message: "the run exceeded its 900 ms budget" });
		expect(code).toBe(3);
	});

	it("keeps an accepted submission when the timeout stops a driver that kept going", async () => {
		const { code, events } = await execute(
			driver(async (ctx) => {
				ctx.submit.call(GOOD);
				await aborted(ctx);
			}),
			makeInput(undefined, { timeout_ms: 1000 }),
		);
		expect(terminal(events)).toMatchObject({ type: "result", output: GOOD });
		expect(code).toBe(0);
	});

	it("times out a driver that is still opening, without starting", async () => {
		const { code, events } = await execute({ open: (ctx) => aborted(ctx).then(() => ({ version: "1", model: "m", run: async () => {} })) }, makeInput(undefined, { timeout_ms: 1000 }));
		expect(events).toEqual([expect.objectContaining({ type: "error", code: "timeout" })]);
		expect(code).toBe(3);
	});

	it("cancels on the run's signal, mid-run or before it starts", async () => {
		const controller = new AbortController();
		const mid = await execute(
			driver(async (ctx) => {
				controller.abort();
				await aborted(ctx);
			}),
			makeInput(undefined),
			controller.signal,
		);
		expect(terminal(mid.events)).toMatchObject({ type: "error", code: "agent_error", message: "the run was cancelled" });

		const before = await execute(driver(async () => {}), makeInput(undefined), AbortSignal.abort());
		expect(before.events).toEqual([expect.objectContaining({ type: "error", code: "agent_error", message: "the run was cancelled" })]);
	});

	it("reports the outcome after a grace period when the driver ignores the stop", async () => {
		const started = Date.now();
		const { events } = await execute(
			driver(async (ctx) => {
				ctx.requestModel();
				await new Promise(() => {});
			}),
			makeInput(undefined, { max_turns: 1, timeout_ms: 1000 }),
		);
		expect(terminal(events)).toMatchObject({ type: "error", code: "timeout" });
		expect(Date.now() - started).toBeGreaterThanOrEqual(5_000);
	});

	it("gives the driver exactly the input's tools, and refuses them once the run is over", async () => {
		let names: string[] = [];
		let afterEnd: unknown;
		await execute(
			driver(async (ctx) => {
				names = ctx.tools.map((t) => t.name);
				ctx.submit.call(GOOD);
				afterEnd = await ctx.tools[0]?.execute({});
			}),
			makeInput(makeWorkspace(), { tools: ["ls", "read"] }),
		);
		expect(names).toEqual(["ls", "read"]);
		expect(afterEnd).toEqual({ text: "The run is over.", isError: true });

		let none: number | undefined;
		await execute(
			driver(async (ctx) => {
				none = ctx.tools.length;
			}),
		);
		expect(none).toBe(0);
	});

	it("emits a tool result only for an announced call, truncated, and nothing after the outcome", async () => {
		let captured: DriverContext | undefined;
		const run = await execute(
			driver(async (ctx) => {
				captured = ctx;
				ctx.report.toolResult("never-announced", "ls", "text", false);
				ctx.report.toolCall("c1", "ls", {});
				ctx.report.toolResult("c1", "ls", "x".repeat(5000), false);
				ctx.report.toolResult("c1", "ls", "duplicate", false);
				ctx.submit.call(GOOD);
			}),
		);
		captured?.report.text("after the outcome");
		const events = await run.later();
		const results = toolResults(events);
		expect(results).toHaveLength(1);
		expect(results[0]?.tool_call_id).toBe("c1");
		expect(results[0]?.output_preview).toHaveLength(2000);
		expect(results[0]?.output_preview.endsWith("…[truncated]")).toBe(true);
		expect(events.some((e) => e.type === "assistant_text")).toBe(false);
		expect(terminal(events)).toMatchObject({ type: "result" });
	});
});
