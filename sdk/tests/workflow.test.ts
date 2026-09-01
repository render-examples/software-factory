import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	configureFactoryStore,
	createMemoryFactoryStore,
	type FactoryStore,
} from "#factory/store";

vi.mock("@renderinc/sdk/workflows", () => ({
	task: (_opts: unknown, fn: (...args: unknown[]) => unknown) => fn,
	TaskRegistry: { getInstance: () => ({ clear: () => {} }) },
}));

import { workflow } from "../workflow.js";

let store: FactoryStore;

beforeEach(() => {
	store = createMemoryFactoryStore();
	configureFactoryStore(store);
});

afterEach(async () => {
	await store.close();
});

describe("workflow() shim", () => {
	describe("ctx.step()", () => {
		it("executes a step and returns its result", async () => {
			const wf = workflow(
				{ name: "test-wf" },
				async (ctx) => {
					const value = await ctx.step("greet", async () => "hello");
					return value;
				},
			);
			const result = await wf({ runId: "run-1" });
			expect(result).toBe("hello");
		});

		it("memoizes a step on replay — does not re-execute", async () => {
			const fn = vi.fn().mockResolvedValue(42);
			const wf = workflow(
				{ name: "test-memo" },
				async (ctx) => {
					const value = await ctx.step("compute", fn);
					return value;
				},
			);

			const first = await wf({ runId: "run-memo" });
			expect(first).toBe(42);
			expect(fn).toHaveBeenCalledOnce();

			const second = await wf({ runId: "run-memo" });
			expect(second).toBe(42);
			expect(fn).toHaveBeenCalledOnce();
		});

		it("memoizes multiple steps independently", async () => {
			const fnA = vi.fn().mockResolvedValue("a");
			const fnB = vi.fn().mockResolvedValue("b");
			const wf = workflow(
				{ name: "test-multi" },
				async (ctx) => {
					const a = await ctx.step("step-a", fnA);
					const b = await ctx.step("step-b", fnB);
					return `${a}+${b}`;
				},
			);

			const result = await wf({ runId: "run-multi" });
			expect(result).toBe("a+b");
			expect(fnA).toHaveBeenCalledOnce();
			expect(fnB).toHaveBeenCalledOnce();

			const replay = await wf({ runId: "run-multi" });
			expect(replay).toBe("a+b");
			expect(fnA).toHaveBeenCalledOnce();
			expect(fnB).toHaveBeenCalledOnce();
		});

		it("disambiguates repeated step names by invocation order", async () => {
			const fn = vi.fn()
				.mockResolvedValueOnce("first")
				.mockResolvedValueOnce("second");
			const wf = workflow(
				{ name: "test-dup-names" },
				async (ctx) => {
					const a = await ctx.step("repeat", fn);
					const b = await ctx.step("repeat", fn);
					return `${a},${b}`;
				},
			);

			const result = await wf({ runId: "run-dup" });
			expect(result).toBe("first,second");
			expect(fn).toHaveBeenCalledTimes(2);
		});

		it("stores null for void-returning steps", async () => {
			const wf = workflow(
				{ name: "test-void" },
				async (ctx) => {
					await ctx.step("side-effect", async () => {});
					return "done";
				},
			);

			const result = await wf({ runId: "run-void" });
			expect(result).toBe("done");

			const replay = await wf({ runId: "run-void" });
			expect(replay).toBe("done");
		});

		it("propagates step errors without memoizing them", async () => {
			let attempt = 0;
			const wf = workflow(
				{ name: "test-error" },
				async (ctx) => {
					attempt++;
					if (attempt === 1) {
						await ctx.step("fail", async () => {
							throw new Error("boom");
						});
					}
					return await ctx.step("succeed", async () => "ok");
				},
			);

			await expect(wf({ runId: "run-error" })).rejects.toThrow("boom");
		});
	});

	describe("ctx.sleep()", () => {
		it("resolves after the specified duration", async () => {
			vi.useFakeTimers();
			const wf = workflow(
				{ name: "test-sleep" },
				async (ctx) => {
					await ctx.sleep("100ms");
					return "awake";
				},
			);

			const promise = wf({ runId: "run-sleep" });
			await vi.advanceTimersByTimeAsync(200);
			const result = await promise;
			expect(result).toBe("awake");
			vi.useRealTimers();
		});

		it("is memoized on replay and does not re-sleep", async () => {
			const wf = workflow(
				{ name: "test-sleep-replay" },
				async (ctx) => {
					await ctx.sleep("1ms");
					return "done";
				},
			);

			const first = await wf({ runId: "run-sleep-replay" });
			expect(first).toBe("done");

			const start = Date.now();
			const second = await wf({ runId: "run-sleep-replay" });
			const elapsed = Date.now() - start;
			expect(second).toBe("done");
			expect(elapsed).toBeLessThan(50);
		});
	});

	describe("ctx.runContext()", () => {
		it("provides a run context scoped to the workflow", async () => {
			let captured: unknown;
			const wf = workflow(
				{ name: "test-ctx" },
				async (ctx) => {
					captured = ctx.runContext("my-step");
					return "ok";
				},
			);

			await wf({ runId: "run-ctx" });
			expect(captured).toMatchObject({
				rootRunId: "run-ctx",
				runId: "run-ctx",
				stepKey: "my-step",
				generation: 0,
			});
		});
	});

	describe("duration parsing", () => {
		it("parses various duration formats", async () => {
			vi.useFakeTimers();
			const durations: string[] = [];
			const wf = workflow(
				{ name: "test-durations" },
				async (ctx) => {
					for (const d of ["1ms", "5s", "2m", "1h", "7 days"]) {
						await ctx.sleep(d);
						durations.push(d);
					}
					return durations.length;
				},
			);

			const promise = wf({ runId: "run-dur" });
			await vi.advanceTimersByTimeAsync(7 * 86_400_000 + 3_600_000 + 120_000 + 5_000 + 1);
			const result = await promise;
			expect(result).toBe(5);
			vi.useRealTimers();
		});

		it("rejects invalid durations", async () => {
			const wf = workflow(
				{ name: "test-bad-dur" },
				async (ctx) => {
					await ctx.sleep("forever");
					return "never";
				},
			);

			await expect(wf({ runId: "run-bad" })).rejects.toThrow(/Invalid duration/);
		});
	});

	describe("terminal state", () => {
		it("marks the run as completed in the store", async () => {
			const wf = workflow(
				{ name: "test-complete" },
				async () => ({ status: "done" }),
			);

			await wf({ runId: "run-complete" });
			const run = await store.runs.getRun("run-complete");
			expect(run?.status).toBe("completed");
		});

		it("increments failure count on error", async () => {
			const wf = workflow(
				{ name: "test-fail" },
				async () => {
					throw new Error("kaboom");
				},
			);

			await expect(wf({ runId: "run-fail" })).rejects.toThrow("kaboom");
			const run = await store.runs.getRun("run-fail");
			expect(run?.failureCount).toBe(1);
		});
	});
});
