import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelSelection, Run, SDKCustomTool } from "@cursor/sdk";
import { errorMessage, previewText } from "../core/emit.js";
import type { HarnessRun } from "../core/harness.js";
import { RUNNER_EXIT, type RunnerErrorCode } from "../core/protocol.js";
import { SUBMIT_ACCEPTED, SUBMIT_DUPLICATE, SUBMIT_TOOL, Submission, submitDescription, submitParameters } from "../core/submit.js";
import { createFactoryTools } from "../tools/index.js";

type CursorSdk = typeof import("@cursor/sdk");

const HERE = fileURLToPath(import.meta.url);
/** Bundled, this module is the sandbox's APP_DIR/runner/runner.mjs; the SDK is provisioned at APP_DIR/cursor-sdk/. */
const BUNDLED = HERE.endsWith(".mjs");

/** Time kept back from `timeout_ms` so the runner reports its own timeout before the host kills it. */
const SAFETY_MARGIN_MS = 10_000;

const SUBMIT_REMINDER = `You stopped without calling ${SUBMIT_TOOL}. Call it now, exactly once, with your final output built from what you have found so far.`;

/** The SDK: the sandbox's provisioned install (a single-file bundle can't hold it), or the repo's from source. */
export async function loadCursorSdk(): Promise<CursorSdk> {
	if (BUNDLED) return createRequire(join(dirname(HERE), "..", "cursor-sdk", "package.json"))("@cursor/sdk") as CursorSdk;
	return import("@cursor/sdk");
}

export interface CursorRunOptions {
	model: ModelSelection;
	replaceSystemPrompt: boolean;
}

type Failure = { code: RunnerErrorCode; message: string };

/**
 * Runs one agent on a local Cursor agent in this sandbox. The model sees only the factory's tools and `submit`, as
 * custom tools: Cursor's own tools are off (`tools: ["mcp"]`) and so are ambient settings from the checkout.
 */
export async function runCursor(run: HarnessRun, opts: CursorRunOptions): Promise<number> {
	const { input, emit } = run;
	const fail = (code: RunnerErrorCode, message: string) => {
		emit({ type: "error", code, message });
		return code === "invalid_input" ? RUNNER_EXIT.invalid_input : code === "timeout" ? RUNNER_EXIT.timeout : RUNNER_EXIT.error;
	};
	if (run.testScript) return fail("invalid_input", "the cursor harness has no test model: it runs only against Cursor's hosted models");
	if (!run.apiKey) return fail("agent_error", "no Cursor API key: pass it with --key-stdin");

	let sdk: CursorSdk;
	try {
		sdk = await loadCursorSdk();
	} catch (err) {
		return fail("agent_error", `could not load the Cursor SDK: ${errorMessage(err)}`);
	}
	emit({ type: "started", agent_id: input.agent_id, harness: "cursor", harness_version: cursorSdkVersion(), model: opts.model.id });

	const submission = new Submission(input.output_schema);
	let failure: Failure | undefined;
	let stopped = false;
	let current: Run | undefined;
	let turns = 0;
	let inTurn = false;
	let calls = 0;
	const stop = (reason?: Failure) => {
		if (reason) failure ??= reason;
		if (stopped) return;
		stopped = true;
		void current?.cancel().catch(() => {});
	};

	/** Records a call, counting a new turn when the model starts a new batch. False when the call must not run. */
	const begin = (tool: string, args: unknown): { id: string; allowed: boolean } => {
		const id = `call-${++calls}`;
		if (!inTurn) {
			inTurn = true;
			turns++;
		}
		emit({ type: "tool_call", tool_call_id: id, tool, args });
		if (stopped || submission.accepted) {
			// Work after an accepted submission (or a stop) ends the run; the submission stands.
			stop();
			return { id, allowed: false };
		}
		if (turns > input.max_turns) {
			stop({ code: "max_turns", message: `turn limit (${input.max_turns}) reached without a submission` });
			return { id, allowed: false };
		}
		return { id, allowed: true };
	};
	const result = (id: string, tool: string, text: string, isError: boolean) =>
		emit({ type: "tool_result", tool_call_id: id, tool, is_error: isError, output_preview: previewText(text) });

	const customTools: Record<string, SDKCustomTool> = {};
	const tools =
		input.tools.length > 0 && input.cwd && input.scratch_dir
			? createFactoryTools({ tools: input.tools, cwd: input.cwd, scratchDir: input.scratch_dir })
			: [];
	for (const tool of tools) {
		customTools[tool.name] = {
			description: tool.description,
			inputSchema: tool.parameters as SDKCustomTool["inputSchema"],
			async execute(args) {
				const call = begin(tool.name, args);
				if (!call.allowed) {
					result(call.id, tool.name, "The run is over.", true);
					return { content: [{ type: "text", text: "The run is over." }], isError: true };
				}
				const out = await tool.execute(args);
				result(call.id, tool.name, out.text, out.isError);
				return { content: [{ type: "text", text: out.text }], isError: out.isError };
			},
		};
	}
	customTools[SUBMIT_TOOL] = {
		description: submitDescription(input.output_schema),
		inputSchema: submitParameters(input.output_schema) as SDKCustomTool["inputSchema"],
		async execute(args) {
			if (submission.accepted) {
				const id = `call-${++calls}`;
				emit({ type: "tool_call", tool_call_id: id, tool: SUBMIT_TOOL, args });
				result(id, SUBMIT_TOOL, SUBMIT_DUPLICATE, false);
				return SUBMIT_DUPLICATE;
			}
			const call = begin(SUBMIT_TOOL, args);
			if (!call.allowed) {
				result(call.id, SUBMIT_TOOL, "The run is over.", true);
				return { content: [{ type: "text", text: "The run is over." }], isError: true };
			}
			const verdict = submission.check(args);
			if (verdict.ok) {
				submission.accept(verdict.checked);
				result(call.id, SUBMIT_TOOL, SUBMIT_ACCEPTED, false);
				return SUBMIT_ACCEPTED;
			}
			result(call.id, SUBMIT_TOOL, verdict.message, true);
			if (verdict.exhausted) stop({ code: "invalid_submission", message: verdict.exhausted });
			return { content: [{ type: "text", text: verdict.message }], isError: true };
		},
	};

	const scratch = input.scratch_dir ?? tmpdir();
	const storeDir = join(scratch, `cursor-store-${randomUUID()}`);
	const budgetMs = input.timeout_ms - Math.min(SAFETY_MARGIN_MS, Math.floor(input.timeout_ms / 10));
	const deadline = setTimeout(
		() => stop({ code: "timeout", message: `the run exceeded its ${budgetMs} ms budget` }),
		Math.max(0, run.startedAt + budgetMs - Date.now()),
	);
	const onAbort = () => stop({ code: "agent_error", message: "the run was cancelled" });
	run.signal?.addEventListener("abort", onAbort, { once: true });

	let lastError: string | undefined;
	const consume = async (sdkRun: Run) => {
		current = sdkRun;
		if (stopped) await sdkRun.cancel().catch(() => {});
		for await (const message of sdkRun.stream()) {
			if (message.type === "thinking") inTurn = false;
			else if (message.type === "assistant") {
				inTurn = false;
				const text = message.message.content
					.flatMap((block) => (block.type === "text" ? [block.text] : []))
					.join("")
					.trim();
				if (text) emit({ type: "assistant_text", text });
			} else if (message.type === "usage") {
				inTurn = false;
				const u = message.usage;
				emit({
					type: "usage",
					usage: {
						input_tokens: u.inputTokens,
						output_tokens: u.outputTokens,
						cache_read_tokens: u.cacheReadTokens,
						cache_write_tokens: u.cacheWriteTokens,
					},
				});
			} else if (message.type === "status" && message.status === "ERROR") lastError = message.message;
		}
		return sdkRun.wait();
	};

	const agent = await sdk.Agent.create({
		apiKey: run.apiKey,
		model: opts.model,
		// Only MCP tools, and the only MCP server is the custom tools: no Cursor shell, file, web, or subagent tools.
		tools: ["mcp"],
		...(opts.replaceSystemPrompt ? { systemPrompt: input.system_prompt } : {}),
		local: {
			cwd: input.cwd ?? scratch,
			// No .cursor/ settings, MCP servers, or hooks from the (untrusted) checkout or the runner's home.
			settingSources: [],
			customTools,
			store: new sdk.JsonlLocalAgentStore(storeDir),
		},
	});
	try {
		const first = opts.replaceSystemPrompt
			? input.message
			: `<instructions>\n${input.system_prompt}\n</instructions>\n\n<task>\n${input.message}\n</task>`;
		let outcome = await consume(await agent.send(first));
		if (!submission.accepted && !failure && outcome.status === "finished") outcome = await consume(await agent.send(SUBMIT_REMINDER));
		if (submission.accepted) {
			emit({ type: "result", output: submission.accepted.output, turns });
			return RUNNER_EXIT.ok;
		}
		if (failure) return fail(failure.code, failure.message);
		if (outcome.status === "error") return fail("agent_error", outcome.error?.message ?? lastError ?? "the Cursor run failed");
		return fail("no_submission", `the model stopped without calling ${SUBMIT_TOOL}, even after a reminder`);
	} catch (err) {
		if (submission.accepted && !emit.terminated) {
			emit({ type: "result", output: submission.accepted.output, turns });
			return RUNNER_EXIT.ok;
		}
		return failure ? fail(failure.code, failure.message) : fail("agent_error", errorMessage(err));
	} finally {
		clearTimeout(deadline);
		run.signal?.removeEventListener("abort", onAbort);
		await agent[Symbol.asyncDispose]().catch(() => {});
		await rm(storeDir, { recursive: true, force: true }).catch(() => {});
	}
}

/** The installed SDK's version, from its package.json (which the package's exports map doesn't expose). */
export function cursorSdkVersion(): string {
	try {
		const base = BUNDLED ? join(dirname(HERE), "..", "cursor-sdk", "package.json") : HERE;
		const entry = createRequire(base).resolve("@cursor/sdk");
		const root = entry.slice(0, entry.lastIndexOf(`${sep}@cursor${sep}sdk${sep}`) + `${sep}@cursor${sep}sdk`.length);
		return (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;
	} catch {
		return "unknown";
	}
}
