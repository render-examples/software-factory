import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { createFactoryTools, type FactoryTool } from "../tools/index.js";
import type { DriverContext, DriverSession, SubmitTool } from "./driver.js";
import { InvalidInput } from "./driver.js";
import { errorMessage, previewText } from "./emit.js";
import type { HarnessRun, HarnessRuntime } from "./harness.js";
import { RUNNER_EXIT, type RunnerErrorCode } from "./protocol.js";
import { SUBMIT_ACCEPTED, SUBMIT_DUPLICATE, SUBMIT_TOOL, Submission, submitDescription, submitParameters } from "./submit.js";

/** Time kept back from `timeout_ms` so the runner reports its own timeout before the host kills it. */
const SAFETY_MARGIN_MS = 10_000;
/** How long a driver may take to stop after the run ends before the outcome is reported anyway. */
const STOP_GRACE_MS = 5_000;
const RUN_OVER = "The run is over.";

type Outcome = { type: "result"; output: unknown } | { type: "error"; code: RunnerErrorCode; message: string };

/**
 * Runs one agent on `harness.driver` and returns the exit code. The kernel emits `started`, then exactly one
 * `result` or `error`: the first outcome reached (an accepted submission, a rejected last submission, the turn
 * limit, the timeout, or cancellation) is final, and the driver is stopped once it is.
 */
export async function executeHarness(run: HarnessRun, harness: HarnessRuntime): Promise<number> {
	const { input, emit } = run;
	const stop = new AbortController();
	let outcome: Outcome | undefined;
	/** Records the outcome if it's the first; the driver may finish its current step (e.g. the submit result). */
	const end = (next: Outcome) => {
		outcome ??= next;
	};
	/** Records the outcome if it's the first, and stops the driver either way. */
	const halt = (next: Outcome) => {
		end(next);
		stop.abort();
	};

	let requests = 0;
	const requestModel = () => {
		if (outcome) return false;
		if (requests >= input.max_turns) {
			halt({ type: "error", code: "max_turns", message: `turn limit (${input.max_turns}) reached without a submission` });
			return false;
		}
		requests++;
		return true;
	};

	const submission = new Submission(input.output_schema);
	const submit: SubmitTool = {
		name: SUBMIT_TOOL,
		description: submitDescription(input.output_schema),
		parameters: submitParameters(input.output_schema),
		call(args) {
			if (submission.accepted) return { text: SUBMIT_DUPLICATE, isError: false };
			if (outcome) return { text: RUN_OVER, isError: true };
			const verdict = submission.check(args);
			if (verdict.ok) {
				submission.accept(verdict.checked);
				end({ type: "result", output: verdict.checked });
				return { text: SUBMIT_ACCEPTED, isError: false };
			}
			if (verdict.exhausted) halt({ type: "error", code: "invalid_submission", message: verdict.exhausted });
			return { text: verdict.message, isError: true };
		},
	};

	const tools: FactoryTool[] = (
		input.tools.length > 0 && input.cwd && input.scratch_dir
			? createFactoryTools({ tools: input.tools, cwd: input.cwd, scratchDir: input.scratch_dir })
			: []
	).map((tool) => ({
		...tool,
		async execute(args, signal) {
			if (outcome) return { text: RUN_OVER, isError: true };
			return tool.execute(args, signal ? AbortSignal.any([signal, stop.signal]) : stop.signal);
		},
	}));

	const announced = new Set<string>();
	const scratchDir = input.scratch_dir ?? tmpdir();
	const ctx: DriverContext = {
		systemPrompt: input.system_prompt,
		message: input.message,
		apiKey: run.apiKey,
		cwd: input.cwd ?? scratchDir,
		scratchDir,
		tools,
		submit,
		signal: stop.signal,
		requestModel,
		report: {
			text: (text) => emit({ type: "assistant_text", text }),
			usage: (usage) => emit({ type: "usage", usage }),
			toolCall(id, tool, args) {
				announced.add(id);
				emit({ type: "tool_call", tool_call_id: id, tool, args });
			},
			toolResult(id, tool, text, isError) {
				if (!announced.delete(id)) return;
				emit({ type: "tool_result", tool_call_id: id, tool, is_error: isError, output_preview: previewText(text) });
			},
		},
	};

	const budgetMs = input.timeout_ms - Math.min(SAFETY_MARGIN_MS, Math.floor(input.timeout_ms / 10));
	const deadline = setTimeout(
		() => halt({ type: "error", code: "timeout", message: `the run exceeded its ${budgetMs} ms budget` }),
		Math.max(0, run.startedAt + budgetMs - Date.now()),
	);
	const onCancel = () => halt({ type: "error", code: "agent_error", message: "the run was cancelled" });
	if (run.signal?.aborted) onCancel();
	run.signal?.addEventListener("abort", onCancel, { once: true });
	const grace = new AbortController();
	const stopped = new Promise<void>((resolve) =>
		stop.signal.addEventListener("abort", () => void sleep(STOP_GRACE_MS, undefined, { signal: grace.signal }).then(resolve, resolve), {
			once: true,
		}),
	);

	let failure: { error: unknown } | undefined;
	/** Runs a driver step until it settles, or until the run has ended and the driver had its grace to stop. */
	const step = async <T>(work: () => T | Promise<T>): Promise<T | undefined> => {
		const settled = Promise.resolve()
			.then(work)
			.catch((error: unknown) => {
				failure ??= { error };
				return undefined;
			});
		return Promise.race([settled, stopped.then(() => undefined)]);
	};
	try {
		const session: DriverSession | undefined = outcome ? undefined : await step(() => harness.driver.open(ctx));
		if (session && !outcome) {
			emit({ type: "started", agent_id: input.agent_id, harness: harness.name, harness_version: session.version, model: session.model });
			await step(() => session.run());
		} else if (!outcome && failure) {
			const { error } = failure;
			end({ type: "error", code: error instanceof InvalidInput ? "invalid_input" : "agent_error", message: errorMessage(error) });
		}
	} finally {
		grace.abort();
		clearTimeout(deadline);
		run.signal?.removeEventListener("abort", onCancel);
		stop.abort();
	}

	const final: Outcome = outcome ??
		(failure
			? { type: "error", code: "agent_error", message: errorMessage(failure.error) }
			: { type: "error", code: "no_submission", message: `the model stopped without calling ${SUBMIT_TOOL}` });
	if (final.type === "result") {
		emit({ type: "result", output: final.output, turns: requests });
		return RUNNER_EXIT.ok;
	}
	emit({ type: "error", code: final.code, message: final.message });
	if (final.code === "timeout") return RUNNER_EXIT.timeout;
	return final.code === "invalid_input" ? RUNNER_EXIT.invalid_input : RUNNER_EXIT.error;
}
