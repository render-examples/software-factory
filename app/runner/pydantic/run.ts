import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { errorMessage } from "../core/emit.js";
import type { HarnessRun, HarnessSelfTest } from "../core/harness.js";
import { RUNNER_EXIT, RunnerEvent } from "../core/protocol.js";

const HERE = fileURLToPath(import.meta.url);
/** Bundled, this module is the sandbox's APP_DIR/runner/runner.mjs; from source it is app/runner/pydantic/run.ts. */
const BUNDLED = HERE.endsWith(".mjs");

/** The Python sources (factory_harness and agent modules): APP_DIR/runner/python/ in the sandbox, python/ in the repo. */
export const PYTHON_ROOT = BUNDLED ? join(dirname(HERE), "python") : fileURLToPath(new URL("../../../python/", import.meta.url));
/** The root-owned virtual environment the snapshot installs (APP_DIR/python-env), or the repo's `uv sync` venv. */
const PYTHON = BUNDLED ? join(dirname(HERE), "..", "python-env", "bin", "python") : join(PYTHON_ROOT, ".venv", "bin", "python");

/** How the wrapper starts this runner as the factory-tool MCP server. */
function mcpCommand(): { command: string; args: string[] } {
	if (BUNDLED) return { command: process.execPath, args: [HERE, "--mcp-tools"] };
	const main = fileURLToPath(new URL("../main.ts", import.meta.url));
	return { command: process.execPath, args: ["--import", import.meta.resolve("tsx"), main, "--mcp-tools"] };
}

/** The wrapper's environment: what Python and the libraries need, never a key (the key travels on stdin). */
function pythonEnv(): Record<string, string> {
	const pass = ["PATH", "LANG", "HOME", "TMPDIR", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS"];
	const env: Record<string, string> = {};
	for (const name of pass) {
		const value = process.env[name];
		if (value) env[name] = value;
	}
	return {
		...env,
		PYTHONPATH: PYTHON_ROOT,
		PYTHONDONTWRITEBYTECODE: "1",
		PYTHONNOUSERSITE: "1",
		PYTHONUNBUFFERED: "1",
		PYDANTIC_AI_NO_BANNER: "1",
	};
}

export interface PydanticRunOptions {
	module: string;
	keyEnv: string;
}

/**
 * Runs `python -m factory_harness --module <module>` as this (unprivileged) user and forwards its RunnerEvents.
 * The key reaches the wrapper on stdin only. The wrapper connects to this runner's MCP tool server for exactly the
 * input's tools, so tool authority and the read-only policy are the factory's.
 */
export async function runPydantic(run: HarnessRun, opts: PydanticRunOptions): Promise<number> {
	const { input, emit } = run;
	const fail = (code: "agent_error" | "timeout" | "invalid_input", message: string) => {
		emit({ type: "error", code, message });
		return code === "timeout" ? RUNNER_EXIT.timeout : code === "invalid_input" ? RUNNER_EXIT.invalid_input : RUNNER_EXIT.error;
	};
	if (!existsSync(PYTHON)) return fail("agent_error", `no Python environment at ${PYTHON}: the sandbox needs the pydantic harness's dependencies`);

	const { test_script: _script, ...rest } = input;
	const mcp = mcpCommand();
	const handoff = {
		input: rest,
		api_key: run.apiKey ?? null,
		key_env: opts.keyEnv,
		test_script: run.testScript ?? null,
		mcp:
			input.tools.length > 0 && input.cwd && input.scratch_dir
				? { command: mcp.command, args: [...mcp.args, "--tools", input.tools.join(","), "--cwd", input.cwd, "--scratch-dir", input.scratch_dir] }
				: null,
	};

	const child = spawn(PYTHON, ["-m", "factory_harness", "--module", opts.module], {
		cwd: PYTHON_ROOT,
		env: pythonEnv(),
		stdio: ["pipe", "pipe", "inherit"],
	});
	const exited = new Promise<number | null>((resolve) => {
		child.on("close", (code) => resolve(code));
		child.on("error", () => resolve(null));
	});
	child.stdin.on("error", () => {});
	child.stdin.end(JSON.stringify(handoff));

	// The wrapper reports its own timeout first; this kill is the backstop.
	let timedOut = false;
	const deadline = setTimeout(
		() => {
			timedOut = true;
			child.kill("SIGKILL");
		},
		Math.max(0, run.startedAt + input.timeout_ms - Date.now()),
	);
	const onAbort = () => child.kill("SIGKILL");
	run.signal?.addEventListener("abort", onAbort, { once: true });

	let invalid = 0;
	let buffer = "";
	const forward = (line: string) => {
		if (!line.trim()) return;
		let parsed: ReturnType<typeof RunnerEvent.safeParse>;
		try {
			parsed = RunnerEvent.safeParse(JSON.parse(line));
		} catch {
			invalid++;
			return;
		}
		if (!parsed.success) {
			invalid++;
			return;
		}
		const { at: _at, ...event } = parsed.data;
		emit(event as Parameters<typeof emit>[0]);
	};
	try {
		for await (const chunk of child.stdout) {
			buffer += Buffer.from(chunk).toString("utf8");
			let newline = buffer.indexOf("\n");
			while (newline !== -1) {
				forward(buffer.slice(0, newline));
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf("\n");
			}
		}
		forward(buffer);
	} catch (err) {
		if (!emit.terminated) return fail("agent_error", `reading the pydantic harness failed: ${errorMessage(err)}`);
	}
	const code = await exited;
	clearTimeout(deadline);
	run.signal?.removeEventListener("abort", onAbort);

	if (!emit.terminated) {
		if (timedOut) return fail("timeout", `the run exceeded its ${input.timeout_ms} ms budget`);
		if (run.signal?.aborted) return fail("agent_error", "the run was cancelled");
		const extra = invalid ? `; ${invalid} invalid event line${invalid === 1 ? "" : "s"}` : "";
		return fail("agent_error", `the pydantic harness exited ${code ?? "abnormally"} without a result${extra}`);
	}
	return code === RUNNER_EXIT.ok || code === RUNNER_EXIT.invalid_input || code === RUNNER_EXIT.timeout ? code : RUNNER_EXIT.error;
}

/** The installed Pydantic AI version, and problems with this sandbox's Python environment for `module`. */
export async function pydanticSelfTest(module: string): Promise<HarnessSelfTest> {
	const failed = (problem: string): HarnessSelfTest => ({ version: "unknown", problems: [problem] });
	if (!existsSync(PYTHON)) return failed(`pydantic: no Python environment at ${PYTHON}`);
	if (!existsSync(join(PYTHON_ROOT, module))) return failed(`pydantic: agent module ${module} is missing from ${PYTHON_ROOT}`);
	const child = spawn(PYTHON, ["-m", "factory_harness", "--self-test"], { cwd: PYTHON_ROOT, env: pythonEnv(), stdio: ["ignore", "pipe", "pipe"] });
	let out = "";
	let err = "";
	child.stdout.on("data", (d) => {
		out += d;
	});
	child.stderr.on("data", (d) => {
		err += d;
	});
	const code = await new Promise<number | null>((resolve) => {
		child.on("close", resolve);
		child.on("error", () => resolve(null));
	});
	if (code !== 0) return failed(`pydantic: the Python self-test exited ${code}: ${err.trim().slice(-500)}`);
	try {
		const report = JSON.parse(out.trim().split("\n").pop() ?? "") as { ok?: boolean; pydantic_ai?: string };
		const version = report.pydantic_ai ?? "unknown";
		return report.ok === true ? { version, problems: [] } : { version, problems: ["pydantic: the Python self-test did not report ok"] };
	} catch {
		return failed(`pydantic: unexpected self-test output ${JSON.stringify(out.slice(0, 200))}`);
	}
}
