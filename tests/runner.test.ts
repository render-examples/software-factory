import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	buildRunner,
	call,
	GOOD,
	makeInput,
	makeWorkspace,
	parseEvents,
	runCli,
	runWithTestStub,
	SUBMIT,
	terminal,
	toolResults,
} from "./helpers/runner.js";

let runnerDir: string;

beforeAll(async () => {
	runnerDir = dirname(await buildRunner());
}, 120_000);

afterAll(() => rm(runnerDir, { recursive: true, force: true }));

const ENV_KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "OPENAI_API_KEY", "RENDER_API_KEY"];
afterEach(() => {
	for (const name of ENV_KEYS) delete process.env[name];
});

describe("bundled runner (runner.mjs)", { timeout: 60_000 }, () => {
	it("--test-stub lists the working directory and submits a value built from the output schema", () => {
		const ws = makeWorkspace();
		const { code, stdout, stderr } = runCli(["--test-stub"], JSON.stringify(makeInput(ws)));
		const events = parseEvents(stdout);
		expect(events[0]).toEqual({
			type: "started",
			at: expect.any(String),
			agent_id: "test-agent",
			model: "test-stub/test-stub",
			pi_version: "0.83.0",
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
		const { code, stdout } = runCli(["--test-stub"], JSON.stringify(makeInput(undefined)));
		const events = parseEvents(stdout);
		expect(toolResults(events).map((r) => r.tool)).toEqual([SUBMIT]);
		expect(terminal(events).type).toBe("result");
		expect(code).toBe(0);
	});

	it("--key-stdin takes the key from the first line of stdin and the input from the rest, and never echoes the key", () => {
		const ws = makeWorkspace();
		const key = "sk-ant-test-stdin-0123456789abcdef";
		const { code, stdout, stderr } = runCli(["--test-stub", "--key-stdin"], ` ${key} \r\n${JSON.stringify(makeInput(ws))}`);
		expect(terminal(parseEvents(stdout))).toMatchObject({ type: "result", output: { summary: "[test-stub]" } });
		expect(stdout + stderr).not.toContain(key);
		expect(code).toBe(0);
	});
});

describe("submit", { timeout: 30_000 }, () => {
	it("returns every problem to the model, and accepts the corrected submission", async () => {
		const ws = makeWorkspace();
		const { code, events } = await runWithTestStub(makeInput(ws), () => [
			call(SUBMIT, { summary: "x", files: "README.md", confidence: "maybe", extra: 1 }),
			call(SUBMIT, GOOD),
		]);
		const [first, second] = toolResults(events);
		expect(first).toMatchObject({ tool: SUBMIT, is_error: true });
		expect(first?.output_preview).toContain("attempt 1 of 3");
		for (const field of ["/summary", "/files", "/confidence", "additional properties"]) expect(first?.output_preview).toContain(field);
		expect(second).toMatchObject({ tool: SUBMIT, is_error: false });
		expect(terminal(events)).toMatchObject({ type: "result", output: GOOD, turns: 2 });
		expect(code).toBe(0);
	});
});

describe("run limits", { timeout: 30_000 }, () => {
	it("stops after max_turns without a submission", async () => {
		const ws = makeWorkspace();
		const { code, events } = await runWithTestStub(makeInput(ws, { max_turns: 3 }), () => [
			...Array.from({ length: 5 }, () => call("ls", {})),
			call(SUBMIT, GOOD),
		]);
		expect(terminal(events)).toMatchObject({ type: "error", code: "max_turns", message: expect.stringContaining("turn limit (3)") });
		expect(toolResults(events)).toHaveLength(3);
		expect(code).toBe(1);
	});
});

// Tests that inspect a command's environment have it write to a file: Pi stops reading a command's stdout
// 100 ms after the process exits, so under load the tool result can come back empty.
describe("credentials", { timeout: 30_000 }, () => {
	it("deletes the key file before the session starts and keeps every secret out of the tool env", async () => {
		const ws = makeWorkspace();
		const keyFile = join(ws.scratchDir, "..", "model.key");
		const fileKey = "sk-ant-test-FILEKEY-0123456789";
		writeFileSync(keyFile, `${fileKey}\n`);
		process.env.ANTHROPIC_API_KEY = "sk-ant-test-ENVKEY-9876543210";
		process.env.ANTHROPIC_OAUTH_TOKEN = "oauth-token-value";
		process.env.OPENAI_API_KEY = "sk-openai-not-for-the-model";
		process.env.RENDER_API_KEY = "rnd-not-for-the-model";

		const { code, stdout, events } = await runWithTestStub(
			makeInput(ws, { tools: ["bash", "write"] }),
			() => [
				call("bash", { command: `(test -e ${keyFile} && echo KEY_FILE_PRESENT || echo KEY_FILE_ABSENT; env) > $HOME/env.txt` }),
				call(SUBMIT, GOOD),
			],
			["--key-file", keyFile],
		);

		expect(toolResults(events)[0]?.is_error).toBe(false);
		const env = readFileSync(join(ws.scratchDir, "env.txt"), "utf8");
		expect(env).toContain("KEY_FILE_ABSENT");
		expect(env).toContain(`HOME=${ws.scratchDir}`);
		for (const leaked of ["sk-ant", "sk-openai", "ANTHROPIC", "OPENAI", "oauth-token-value", "RENDER_API_KEY", "rnd-not"])
			expect(env).not.toContain(leaked);
		expect(stdout).not.toContain(fileKey);
		expect(existsSync(keyFile)).toBe(false);
		expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
		expect(code).toBe(0);
	});
});

describe("tools", { timeout: 30_000 }, () => {
	it("read-only agents: bash rejects git push and rm, and runs read-only commands", async () => {
		const ws = makeWorkspace();
		const { events } = await runWithTestStub(makeInput(ws), () => [
			call("bash", { command: "git push origin main" }),
			call("bash", { command: "rm README.md" }),
			call("bash", { command: "echo hi > notes.txt" }),
			call("bash", { command: "git log -1 --format=%H > $HOME/head.txt" }),
			call(SUBMIT, GOOD),
		]);
		const [push, rmCall, redirect, log] = toolResults(events);
		expect(push).toMatchObject({ is_error: true, output_preview: expect.stringContaining("git push is not allowed") });
		expect(rmCall).toMatchObject({ is_error: true, output_preview: expect.stringContaining("rm is only allowed on files in the scratch directory") });
		expect(redirect).toMatchObject({ is_error: true, output_preview: expect.stringContaining("redirecting output to notes.txt") });
		expect(log).toMatchObject({ is_error: false });
		expect(readFileSync(join(ws.scratchDir, "head.txt"), "utf8").trim()).toBe(ws.commit);
		expect(existsSync(join(ws.cwd, "README.md"))).toBe(true);
		expect(existsSync(join(ws.cwd, "notes.txt"))).toBe(false);
	});

	it("agents with edit and write create and edit files in cwd, and bash is unrestricted", async () => {
		const ws = makeWorkspace();
		const { events } = await runWithTestStub(makeInput(ws, { tools: ["read", "bash", "edit", "write"] }), () => [
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
