import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { writeRunnerBundle } from "../../app/runner/bundle.js";
import type { FauxScript } from "../../app/runner/faux.js";
import { main } from "../../app/runner/main.js";
import { RunnerEvent, type RunnerInput, type ToolName } from "../../app/runner/protocol.js";

export const SUBMIT = "submit";

/** The output schema most runner tests use: what `z.toJSONSchema` emits for a small object. */
export const OUTPUT_SCHEMA = {
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
		trace_id: randomUUID(),
		agent_id: "test-agent",
		system_prompt: "You are a test agent.",
		message: "Do the thing.",
		model_provider: "anthropic",
		model: "claude-sonnet-4-5",
		thinking_level: "off",
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

/** Runs main() in-process with a scripted faux model. */
export async function runScripted(input: unknown, script: FauxScript, extraArgs: string[] = []) {
	let stdout = "";
	const code = await main(["--faux", ...extraArgs], {
		stdin: Readable.from([typeof input === "string" ? input : JSON.stringify(input)]),
		write: async (chunk) => {
			stdout += chunk;
		},
		fauxScript: script,
	});
	return { code, stdout, events: parseEvents(stdout) };
}

const toolUse = { stopReason: "toolUse" } as const;
export const say = (text: string) => fauxAssistantMessage(text);
export const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage(fauxToolCall(name, args), toolUse);
export const calls = (...c: Array<[string, Record<string, unknown>]>) =>
	fauxAssistantMessage(
		c.map(([name, args]) => fauxToolCall(name, args)),
		toolUse,
	);

let runnerPath: string | undefined;

/** Bundles the runner into a fresh temp dir, outside the repo, so no node_modules is reachable from it. */
export async function buildRunner(): Promise<string> {
	runnerPath = await writeRunnerBundle(mkdtempSync(join(tmpdir(), "runner-bundle-")));
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
