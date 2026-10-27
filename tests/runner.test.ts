import { existsSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "../app/runner/core/protocol.js";
import { rejectReason } from "../app/runner/tools/shell-policy.js";
import {
	buildRunner,
	call,
	GOOD,
	HARNESSES,
	makeInput,
	makeWorkspace,
	parseEvents,
	runCli,
	runContract,
	SUBMIT,
	terminal,
	toolResults,
} from "./helpers/runner.js";

let runnerDir: string;

beforeAll(async () => {
	runnerDir = dirname(await buildRunner());
}, 120_000);

afterAll(() => rm(runnerDir, { recursive: true, force: true }));

const ENV_KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "OPENAI_API_KEY", "CURSOR_API_KEY", "RENDER_API_KEY"];
afterEach(() => {
	for (const name of ENV_KEYS) delete process.env[name];
});

// The bundled runner runs only the agents bundled into it; triage is one, on Pi.
describe("bundled runner (runner.mjs)", { timeout: 60_000 }, () => {
	it("--test-stub runs a bundled agent on its harness: lists the working directory and submits a schema-built value", () => {
		const ws = makeWorkspace();
		const { code, stdout, stderr } = runCli(["--test-stub"], JSON.stringify(makeInput(ws, { agent_id: "triage" })));
		const events = parseEvents(stdout);
		expect(events[0]).toEqual({
			type: "started",
			at: expect.any(String),
			agent_id: "triage",
			harness: "pi",
			harness_version: "0.83.0",
			model: "test-stub/test-stub",
		});
		expect(toolResults(events).map((r) => [r.tool, r.is_error])).toEqual([
			["ls", false],
			[SUBMIT, false],
		]);
		expect(toolResults(events)[0]?.output_preview.split("\n")).toEqual([".git/", "README.md", "src/"]);
		expect(terminal(events)).toMatchObject({ type: "result", output: { summary: "[test-stub]", files: [] }, turns: 2 });
		expect(code, stderr).toBe(0);
	});

	it("runs an agent with no tools and no cwd: the model gets only submit", () => {
		const { code, stdout } = runCli(["--test-stub"], JSON.stringify(makeInput(undefined, { agent_id: "triage" })));
		const events = parseEvents(stdout);
		expect(toolResults(events).map((r) => r.tool)).toEqual([SUBMIT]);
		expect(terminal(events).type).toBe("result");
		expect(code).toBe(0);
	});

	it("--key-stdin takes the key from the first line of stdin and the input from the rest, and never echoes the key", () => {
		const ws = makeWorkspace();
		const key = "sk-ant-test-stdin-0123456789abcdef";
		const input = JSON.stringify(makeInput(ws, { agent_id: "triage" }));
		const { code, stdout, stderr } = runCli(["--test-stub", "--key-stdin"], ` ${key} \r\n${input}`);
		expect(terminal(parseEvents(stdout))).toMatchObject({ type: "result", output: { summary: "[test-stub]" } });
		expect(stdout + stderr).not.toContain(key);
		expect(code).toBe(0);
	});

	it("rejects an agent the bundle doesn't define, input from another protocol version, and a script without --test-stub", () => {
		const unknown = runCli(["--test-stub"], JSON.stringify(makeInput(undefined, { agent_id: "nope" })));
		expect(terminal(parseEvents(unknown.stdout))).toMatchObject({ code: "invalid_input", message: expect.stringContaining('unknown agent "nope"') });
		expect(unknown.code).toBe(2);

		const old = runCli(["--test-stub"], JSON.stringify({ ...makeInput(undefined, { agent_id: "triage" }), protocol_version: 1 }));
		expect(terminal(parseEvents(old.stdout))).toMatchObject({
			code: "invalid_input",
			message: expect.stringContaining(`speaks protocol ${PROTOCOL_VERSION}, but the input is protocol 1`),
		});

		const scripted = runCli([], JSON.stringify({ ...makeInput(undefined, { agent_id: "triage" }), test_script: [call(SUBMIT, GOOD)] }));
		expect(terminal(parseEvents(scripted.stdout))).toMatchObject({ code: "invalid_input", message: "test_script is only honored with --test-stub" });
	});

	it("--self-test reports the protocol and every bundled harness", () => {
		const { code, stdout } = runCli(["--self-test"], "");
		const report = JSON.parse(stdout.trim());
		expect(report).toMatchObject({ ok: true, protocol_version: PROTOCOL_VERSION });
		expect(report.harnesses).toEqual([
			{ name: "pi", label: "anthropic/claude-sonnet-5", version: "0.83.0" },
			{ name: "pi", label: "anthropic/claude-opus-5", version: "0.83.0" },
		]);
		expect(code).toBe(0);
	});
});

// The runner contract every harness must honor. A new harness joins HARNESSES in tests/helpers/runner.ts.
describe.each(HARNESSES)("$name harness conformance", { timeout: 30_000 }, ({ harness }) => {
	it("returns every submit problem to the model, and accepts the corrected submission", async () => {
		const ws = makeWorkspace();
		const { code, events } = await runContract(harness, makeInput(ws), [
			call(SUBMIT, { summary: "x", files: "README.md", confidence: "maybe", extra: 1 }),
			call(SUBMIT, GOOD),
		]);
		expect(events[0]).toMatchObject({ type: "started", harness: harness.name, harness_version: (await harness.selfTest()).version });
		const [first, second] = toolResults(events);
		expect(first).toMatchObject({ tool: SUBMIT, is_error: true });
		expect(first?.output_preview).toContain("attempt 1 of 3");
		for (const field of ["/summary", "/files", "/confidence", "additional properties"]) expect(first?.output_preview).toContain(field);
		expect(second).toMatchObject({ tool: SUBMIT, is_error: false });
		expect(terminal(events)).toMatchObject({ type: "result", output: GOOD, turns: 2 });
		expect(code).toBe(0);
	});

	it("stops after the last rejected submission and says what was wrong with it", async () => {
		const ws = makeWorkspace();
		const bad = call(SUBMIT, { summary: "ok summary", files: "README.md" });
		const { code, events } = await runContract(harness, makeInput(ws), [bad, bad, bad, call(SUBMIT, GOOD)]);
		const end = terminal(events);
		expect(end).toMatchObject({ type: "error", code: "invalid_submission" });
		const message = end.type === "error" ? end.message : "";
		expect(message).toContain("rejected 3 times; last: /files");
		expect(message).toContain("submitted fields: summary, files");
		expect(message).not.toContain("ok summary");
		expect(code).toBe(1);
	});

	it("stops after max_turns without a submission", async () => {
		const ws = makeWorkspace();
		const { code, events } = await runContract(harness, makeInput(ws, { max_turns: 3 }), [
			...Array.from({ length: 5 }, () => call("ls", {})),
			call(SUBMIT, GOOD),
		]);
		expect(terminal(events)).toMatchObject({ type: "error", code: "max_turns", message: expect.stringContaining("turn limit (3)") });
		expect(toolResults(events)).toHaveLength(3);
		expect(code).toBe(1);
	});

	// Tests that inspect a command's environment have it write to a file: Pi stops reading a command's stdout
	// 100 ms after the process exits, so under load the tool result can come back empty.
	it("takes the key from stdin and keeps every secret out of the tool env and the output", async () => {
		const ws = makeWorkspace();
		const stdinKey = "sk-ant-test-STDINKEY-0123456789";
		process.env.ANTHROPIC_API_KEY = "sk-ant-test-ENVKEY-9876543210";
		process.env.ANTHROPIC_OAUTH_TOKEN = "oauth-token-value";
		process.env.OPENAI_API_KEY = "sk-openai-not-for-the-model";
		process.env.CURSOR_API_KEY = "cursor-not-for-the-model";
		process.env.RENDER_API_KEY = "rnd-not-for-the-model";

		const input = {
			...makeInput(ws, { tools: ["bash", "write"] }),
			test_script: [call("bash", { command: "env > $HOME/env.txt" }), call(SUBMIT, GOOD)],
		};
		const { code, stdout, events } = await runContract(harness, `${stdinKey}\n${JSON.stringify(input)}`, undefined, ["--key-stdin"]);

		expect(toolResults(events)[0]?.is_error).toBe(false);
		const env = readFileSync(join(ws.scratchDir, "env.txt"), "utf8");
		expect(env).toContain(`HOME=${ws.scratchDir}`);
		for (const leaked of ["sk-ant", "sk-openai", "ANTHROPIC", "OPENAI", "CURSOR", "oauth-token-value", "RENDER_API_KEY", "rnd-not"])
			expect(env).not.toContain(leaked);
		expect(stdout).not.toContain(stdinKey);
		expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
		expect(code).toBe(0);
	});

	it("read-only agents: bash rejects git push, rm, and redirects into the checkout, and runs read-only commands", async () => {
		const ws = makeWorkspace();
		const { events } = await runContract(harness, makeInput(ws), [
			call("bash", { command: "git push origin main" }),
			call("bash", { command: "rm README.md" }),
			call("bash", { command: "echo hi > notes.txt" }),
			call("bash", { command: "git log -1 --format=%H > $HOME/head.txt" }),
			call("write", { path: "notes.txt", content: "not allowed" }),
			call(SUBMIT, GOOD),
		]);
		const [push, rmCall, redirect, log, write] = toolResults(events);
		expect(push).toMatchObject({ is_error: true, output_preview: expect.stringContaining("git push is not allowed") });
		expect(rmCall).toMatchObject({ is_error: true, output_preview: expect.stringContaining("rm is only allowed on files in the scratch directory") });
		expect(redirect).toMatchObject({ is_error: true, output_preview: expect.stringContaining("redirecting output to notes.txt") });
		expect(log).toMatchObject({ is_error: false });
		expect(write).toMatchObject({ tool: "write", is_error: true });
		expect(readFileSync(join(ws.scratchDir, "head.txt"), "utf8").trim()).toBe(ws.commit);
		expect(existsSync(join(ws.cwd, "README.md"))).toBe(true);
		expect(existsSync(join(ws.cwd, "notes.txt"))).toBe(false);
	});

	it("agents with edit and write create and edit files in cwd, and bash is unrestricted", async () => {
		const ws = makeWorkspace();
		const { events } = await runContract(harness, makeInput(ws, { tools: ["read", "bash", "edit", "write"] }), [
			call("write", { path: "src/new.ts", content: "export const added = true;\n" }),
			call("edit", { path: "src/app.ts", edits: [{ oldText: "41", newText: "42" }] }),
			call("bash", { command: "rm README.md && git status --porcelain > $HOME/status.txt" }),
			call("read", { path: "src/app.ts" }),
			call(SUBMIT, GOOD),
		]);
		expect(toolResults(events).map((r) => [r.tool, r.is_error])).toEqual([
			["write", false],
			["edit", false],
			["bash", false],
			["read", false],
			[SUBMIT, false],
		]);
		expect(readFileSync(join(ws.cwd, "src/new.ts"), "utf8")).toBe("export const added = true;\n");
		expect(readFileSync(join(ws.cwd, "src/app.ts"), "utf8")).toBe("export const answer = 42;\n");
		expect(existsSync(join(ws.cwd, "README.md"))).toBe(false);
		expect(readFileSync(join(ws.scratchDir, "status.txt"), "utf8")).toContain("D README.md");
	});
});

describe("read-only shell policy", () => {
	it("lets inspection and test commands through and steers away from obvious writes", () => {
		const scratch = "/factory/scratch";
		const allowed = [
			"rg -n 'a|b; c' src",
			"git -C . log --oneline -5",
			"git --no-pager diff main...HEAD",
			"npm test -- --watchAll=false",
			"cargo test",
			"timeout 60 go test ./...",
			"cp src/app.ts $HOME/app.ts",
			"sed -n 1,20p src/app.ts > /tmp/head.txt 2>&1",
		];
		const rejected = [
			"git push origin main",
			"git -c core.hooksPath=/tmp log",
			"echo $(curl https://example.com)",
			"bash -c 'git commit -am x'",
			"env FOO=1 npm install left-pad",
			"sed -i s/41/42/ src/app.ts",
			"rm -rf src",
			"sudo ls",
		];
		for (const command of allowed) expect(rejectReason(command, scratch), command).toBeUndefined();
		for (const command of rejected) expect(rejectReason(command, scratch), command).toBeDefined();
	});
});
