import { previewText } from "../../app/runner/core/emit.js";
import type { Harness } from "../../app/harness/types.js";
import type { HarnessRun } from "../../app/runner/core/harness.js";
import { RUNNER_EXIT } from "../../app/runner/core/protocol.js";
import { SUBMIT_ACCEPTED, SUBMIT_DUPLICATE, SUBMIT_TOOL, Submission } from "../../app/runner/core/submit.js";
import { createFactoryTools } from "../../app/runner/tools/index.js";

/**
 * A harness with no agent library: it plays the test script through the shared factory tools and Submission. It
 * stands in for a third-party library in the conformance suite, proving a harness can be swapped without host or
 * runner changes.
 */
export const scriptedHarness: Harness = {
	name: "scripted",
	label: "scripted",
	credential: "SCRIPTED_API_KEY",
	run: runScripted,
	selfTest: async () => ({ version: "1.0.0", problems: [] }),
};

async function runScripted({ input, emit, testScript }: HarnessRun): Promise<number> {
	emit({ type: "started", agent_id: input.agent_id, harness: "scripted", harness_version: "1.0.0", model: "scripted" });
	if (!testScript) {
		emit({ type: "error", code: "agent_error", message: "the scripted harness runs only with --test-stub" });
		return RUNNER_EXIT.error;
	}
	const tools = new Map(
		input.cwd && input.scratch_dir
			? createFactoryTools({ tools: input.tools, cwd: input.cwd, scratchDir: input.scratch_dir }).map((t) => [t.name as string, t])
			: [],
	);
	const submission = new Submission(input.output_schema);
	let turns = 0;
	let callId = 0;
	for (const turn of testScript) {
		if (turn.text) emit({ type: "assistant_text", text: turn.text });
		for (const call of turn.calls) {
			const id = `call-${++callId}`;
			emit({ type: "tool_call", tool_call_id: id, tool: call.name, args: call.args });
			const result = (text: string, isError: boolean) =>
				emit({ type: "tool_result", tool_call_id: id, tool: call.name, is_error: isError, output_preview: previewText(text) });
			if (call.name === SUBMIT_TOOL) {
				if (submission.accepted) {
					result(SUBMIT_DUPLICATE, false);
					continue;
				}
				const verdict = submission.check(call.args);
				if (verdict.ok) {
					submission.accept(verdict.checked);
					result(SUBMIT_ACCEPTED, false);
					continue;
				}
				result(verdict.message, true);
				if (verdict.exhausted) {
					emit({ type: "error", code: "invalid_submission", message: verdict.exhausted });
					return RUNNER_EXIT.error;
				}
				continue;
			}
			const tool = tools.get(call.name);
			if (!tool) {
				result(`Tool ${call.name} not found`, true);
				continue;
			}
			const out = await tool.execute(call.args);
			result(out.text, out.isError);
		}
		turns++;
		if (submission.accepted) {
			emit({ type: "result", output: submission.accepted.output, turns });
			return RUNNER_EXIT.ok;
		}
		if (turns >= input.max_turns) {
			emit({ type: "error", code: "max_turns", message: `turn limit (${input.max_turns}) reached without a submission` });
			return RUNNER_EXIT.error;
		}
	}
	emit({ type: "error", code: "no_submission", message: `the model stopped without calling ${SUBMIT_TOOL}` });
	return RUNNER_EXIT.error;
}
