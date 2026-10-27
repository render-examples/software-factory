import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { fauxPi } from "./helpers/pi-scripted.js";
import { GOOD, makeInput, makeWorkspace, parseEvents, runContract, SUBMIT, terminal, toolResults } from "./helpers/runner.js";

const calls = (...list: [string, Record<string, unknown>][]) =>
	fauxAssistantMessage(
		list.map(([name, args]) => fauxToolCall(name, args)),
		{ stopReason: "toolUse" },
	);
const overloaded = () => fauxAssistantMessage([], { stopReason: "error", errorMessage: "overloaded_error: Overloaded" });

describe("pi driver", { timeout: 30_000 }, () => {
	it("ends with no_submission when the model stops without submitting, without asking it again", async () => {
		const { harness, stub } = fauxPi([fauxAssistantMessage([fauxText("All done.")]), calls([SUBMIT, GOOD])]);
		const { code, events } = await runContract(harness, makeInput(makeWorkspace()));
		expect(terminal(events)).toMatchObject({ type: "error", code: "no_submission", message: "the model stopped without calling submit" });
		expect(stub.getPendingResponseCount()).toBe(1);
		expect(code).toBe(1);
	});

	it("ends a batch that submits without another model request", async () => {
		const { harness, stub } = fauxPi([calls(["ls", {}], [SUBMIT, GOOD]), calls(["ls", {}])]);
		const { code, events } = await runContract(harness, makeInput(makeWorkspace()));
		expect(toolResults(events).map((r) => [r.tool, r.is_error])).toEqual([
			["ls", false],
			[SUBMIT, false],
		]);
		expect(terminal(events)).toMatchObject({ type: "result", output: GOOD, turns: 1 });
		expect(stub.getPendingResponseCount()).toBe(1);
		expect(code).toBe(0);
	});

	it("retries a transient model error, and the retry counts as a turn", async () => {
		const { harness } = fauxPi([overloaded(), calls([SUBMIT, GOOD])]);
		const { code, events } = await runContract(harness, makeInput(makeWorkspace(), { max_turns: 2 }));
		expect(terminal(events)).toMatchObject({ type: "result", output: GOOD, turns: 2 });
		expect(code).toBe(0);
	});

	it("doesn't send a retry past max_turns", async () => {
		const { harness, stub } = fauxPi([overloaded(), calls([SUBMIT, GOOD])]);
		const { code, events } = await runContract(harness, makeInput(makeWorkspace(), { max_turns: 1 }));
		expect(terminal(events)).toMatchObject({ type: "error", code: "max_turns", message: expect.stringContaining("turn limit (1)") });
		expect(stub.getPendingResponseCount()).toBe(1);
		expect(code).toBe(1);
	});

	it("rejects a model its registry doesn't have, before starting", async () => {
		const { harness } = fauxPi([], "missing");
		const { code, stdout } = await runContract(harness, makeInput(makeWorkspace()));
		expect(parseEvents(stdout)).toEqual([
			expect.objectContaining({ type: "error", code: "invalid_input", message: expect.stringContaining('unknown model "scripted/missing"') }),
		]);
		expect(code).toBe(2);
	});
});
