import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { z } from "zod";
import { type Agent, defineAgent } from "../../app/agents/define.js";
import { pi, pydantic } from "../../app/harness/index.js";
import type { Harness } from "../../app/harness/types.js";
import { PROTOCOL_VERSION, RunnerEvent, type RunnerInput, type TestTurn, type ToolName } from "../../app/runner/core/protocol.js";
import { bundleRunner } from "../../app/runner/bundle.js";
import { main } from "../../app/runner/main.js";
import { scriptedHarness } from "./scripted-harness.js";

export const SUBMIT = "submit";
export const TEST_AGENT_ID = "test-agent";

/** The output schema most runner tests use: what `z.toJSONSchema` emits for a small object. */
const OUTPUT_SCHEMA = {
	$schema: "https://json-schema.org/draft/2020-12/schema",
	type: "object",
	properties: {
		summary: { type: "string", minLength: 3 },
		files: { type: "array", items: { type: "string" } },
		confidence: { type: "string", enum: ["high", "low"] },
	},
	required: ["summary", "files"],
	additionalProperties: false,
} as const;
export const GOOD = { summary: "All good.", files: ["README.md"], confidence: "high" };

/** A test agent on `harness`; the runner takes its tools and schema from the input, so these are placeholders. */
export function testAgent(harness: Harness): Agent {
	return defineAgent({
		id: TEST_AGENT_ID,
		prompt: "../../tests/fixtures/agents/echo.md",
		harness,
		tools: ["read", "ls", "bash", "edit", "write"],
		output: z.object({ summary: z.string() }),
		maxTurns: 20,
	});
}

/** The local Python environment (`uv sync` in python/); the pydantic harness runs only when it exists. */
export const PYTHON_READY = existsSync(new URL("../../python/.venv/bin/python", import.meta.url));

/** Every harness the conformance suite runs against. */
export const HARNESSES: ReadonlyArray<{ name: string; harness: Harness }> = [
	{ name: "pi", harness: pi({ model: getBuiltinModel("anthropic", "claude-sonnet-5"), thinkingLevel: "off" }) },
	{ name: "scripted", harness: scriptedHarness },
	...(PYTHON_READY ? [{ name: "pydantic", harness: pydantic({ module: "agents/sonnet.py", credential: "ANTHROPIC_API_KEY" }) }] : []),
];

export interface Workspace {
	cwd: string;
	scratchDir: string;
	commit: string;
}

/** A one-commit git checkout plus a scratch directory, both in a fresh temp dir. */
export function makeWorkspace(): Workspace {
	const base = mkdtempSync(join(tmpdir(), "runner-test-"));
	const cwd = join(base, "repo");
	const scratchDir = join(base, "scratch");
	mkdirSync(join(cwd, "src"), { recursive: true });
	mkdirSync(scratchDir);
	const git = (...args: string[]) =>
		execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], {
			cwd,
			encoding: "utf8",
		}).trim();
	git("init", "-q", "-b", "main");
	writeFileSync(join(cwd, "README.md"), `${Array.from({ length: 5 }, (_, i) => `readme line ${i + 1}`).join("\n")}\n`);
	writeFileSync(join(cwd, "src/app.ts"), "export const answer = 41;\n");
	git("add", "-A");
	git("commit", "-q", "-m", "initial");
	return { cwd, scratchDir, commit: git("rev-parse", "HEAD") };
}

export function makeInput(ws: Workspace | undefined, overrides: Partial<RunnerInput> = {}): RunnerInput {
	const tools: ToolName[] = overrides.tools ?? (ws ? ["read", "ls", "bash"] : []);
	return {
		protocol_version: PROTOCOL_VERSION,
		trace_id: randomUUID(),
		agent_id: TEST_AGENT_ID,
		system_prompt: "You are a test agent.",
		message: "Do the thing.",
		tools,
		output_schema: OUTPUT_SCHEMA,
		max_turns: 20,
		timeout_ms: 60_000,
		...(ws ? { cwd: ws.cwd, scratch_dir: ws.scratchDir } : {}),
		...overrides,
	};
}

/** Parses stdout JSONL, asserting every line is a valid RunnerEvent. */
export function parseEvents(stdout: string): RunnerEvent[] {
	return stdout
		.split("\n")
		.filter(Boolean)
		.map((line) => RunnerEvent.parse(JSON.parse(line)));
}

export function terminal(events: RunnerEvent[]) {
	const count = events.filter((e) => e.type === "result" || e.type === "error").length;
	if (count !== 1) throw new Error(`expected exactly one terminal event, got ${count}`);
	const last = events.at(-1);
	if (last?.type !== "result" && last?.type !== "error") throw new Error(`last event is ${last?.type}, not terminal`);
	return last;
}

export const toolResults = (events: RunnerEvent[]) => events.flatMap((e) => (e.type === "tool_result" ? [e] : []));

/** One scripted model turn that makes one tool call. */
export const call = (name: string, args: Record<string, unknown>): TestTurn => ({ calls: [{ name, args }] });

/**
 * Runs main() in-process through the runner contract (stdin in, JSONL out), with `harness` behind the test agent
 * and `turns` as the scripted model. `input` may be a string to control stdin exactly (e.g. `--key-stdin`).
 */
export async function runContract(harness: Harness, input: RunnerInput | string, turns?: TestTurn[], extraArgs: string[] = []) {
	let stdin: string;
	if (typeof input === "string") stdin = input;
	else stdin = JSON.stringify(turns ? { ...input, test_script: turns } : input);
	let stdout = "";
	const code = await main(["--test-stub", ...extraArgs], {
		stdin: Readable.from([stdin]),
		write: async (chunk) => {
			stdout += chunk;
		},
		agents: [testAgent(harness)],
	});
	return { code, stdout, events: parseEvents(stdout) };
}

let runnerPath: string | undefined;

/** Bundles the runner into a fresh temp dir, outside the repo, so no node_modules is reachable from it. */
export async function buildRunner(): Promise<string> {
	runnerPath = join(mkdtempSync(join(tmpdir(), "runner-bundle-")), "runner.mjs");
	writeFileSync(runnerPath, await bundleRunner());
	return runnerPath;
}

export function runCli(args: string[], stdin: string, env: NodeJS.ProcessEnv = {}) {
	if (!runnerPath) throw new Error("call buildRunner() in beforeAll first");
	const res = spawnSync(process.execPath, [runnerPath, ...args], {
		input: stdin,
		encoding: "utf8",
		env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
		timeout: 60_000,
	});
	return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}
