import { describe, expect, it } from "vitest";
import { type Driver, type DriverContext, InvalidInput } from "../app/runner/core/driver.js";
import { createEmitter } from "../app/runner/core/emit.js";
import { executeHarness } from "../app/runner/core/kernel.js";
import type { RunnerInput } from "../app/runner/core/protocol.js";
import { GOOD, makeInput, makeWorkspace, parseEvents, terminal, toolResults } from "./helpers/runner.js";

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

	it("reports the driver's failure when the library fails", async () => {
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

	it("times out with the budget left after the safety margin, refusing a later submission, even while the driver is opening", async () => {
		let late: unknown;
		const running = await execute(
			driver(async (ctx) => {
				await aborted(ctx);
				late = ctx.submit.call(GOOD);
			}),
			makeInput(undefined, { timeout_ms: 1000 }),
		);
		expect(late).toEqual({ text: "The run is over.", isError: true });
		expect(terminal(running.events)).toMatchObject({ type: "error", code: "timeout", message: "the run exceeded its 900 ms budget" });
		expect(running.code).toBe(3);

		const opening = await execute(
			{ open: (ctx) => aborted(ctx).then(() => ({ version: "1", model: "m", run: async () => {} })) },
			makeInput(undefined, { timeout_ms: 1000 }),
		);
		expect(opening.events).toEqual([expect.objectContaining({ type: "error", code: "timeout" })]);
		expect(opening.code).toBe(3);
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

		const before = await execute(
			driver(async () => {}),
			makeInput(undefined),
			AbortSignal.abort(),
		);
		expect(before.events).toEqual([expect.objectContaining({ type: "error", code: "agent_error", message: "the run was cancelled" })]);
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
		captured?.report.text("m1", "after the outcome");
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
