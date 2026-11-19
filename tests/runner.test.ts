import { existsSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "../app/runner/core/protocol.js";
import { rejectReason } from "../app/runner/tools/index.js";
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
	TEST_KEY,
	terminal,
	toolResults,
} from "./helpers/runner.js";

let runnerDir: string;

beforeAll(async () => {
	runnerDir = dirname(await buildRunner());
}, 120_000);

afterAll(async () => {
	await rm(runnerDir, { recursive: true, force: true });
});

const ENV_KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "OPENAI_API_KEY", "RENDER_API_KEY"];
afterEach(() => {
	for (const name of ENV_KEYS) delete process.env[name];
});

describe("bundled runner (runner.mjs)", { timeout: 60_000 }, () => {
	it("--self-test loads the bundle and every agent definition, and reports each agent's harness", () => {
		const { code, stdout } = runCli(["--self-test"], "");
		const report = JSON.parse(stdout.trim());
		expect(report).toMatchObject({ ok: true, protocol_version: PROTOCOL_VERSION });
		expect(report.agents).toEqual([
			{ id: "triage", harness: "pi", label: "anthropic/claude-sonnet-5" },
			{ id: "spec-writer", harness: "pi", label: "anthropic/claude-opus-5" },
			{ id: "implementer", harness: "pi", label: "anthropic/claude-opus-5" },
			{ id: "pr-reviewer", harness: "pi", label: "anthropic/claude-sonnet-5" },
		]);
		expect(code).toBe(0);
	});

	it("rejects an agent the bundle doesn't define, input from another protocol version, and a run without a key", () => {
		const keyed = (input: unknown) => `${TEST_KEY}\n${JSON.stringify(input)}`;
		const unknown = runCli(["--key-stdin"], keyed(makeInput(undefined, { agent_id: "nope" })));
		expect(terminal(parseEvents(unknown.stdout))).toMatchObject({ code: "invalid_input", message: expect.stringContaining('unknown agent "nope"') });
		expect(unknown.code).toBe(2);

		const old = runCli(["--key-stdin"], keyed({ ...makeInput(undefined, { agent_id: "triage" }), protocol_version: 1 }));
		expect(terminal(parseEvents(old.stdout))).toMatchObject({
			code: "invalid_input",
			message: expect.stringContaining(`speaks protocol ${PROTOCOL_VERSION}, but the input is protocol 1`),
		});

		const keyless = runCli([], JSON.stringify(makeInput(undefined, { agent_id: "triage" })));
		expect(terminal(parseEvents(keyless.stdout))).toMatchObject({ code: "invalid_input", message: expect.stringContaining("no model key") });

		const empty = runCli(["--key-stdin"], `\n${JSON.stringify(makeInput(undefined, { agent_id: "triage" }))}`);
		expect(terminal(parseEvents(empty.stdout))).toMatchObject({ code: "invalid_input", message: "--key-stdin: the first line of stdin is empty" });
	});
});

describe.each(HARNESSES)("$name harness conformance", { timeout: 30_000 }, ({ make }) => {
	it("returns every submit problem to the model, and accepts the corrected submission", async () => {
		const ws = makeWorkspace();
		const harness = make([call(SUBMIT, { summary: "x", files: "README.md", confidence: "maybe", extra: 1 }), call(SUBMIT, GOOD)]);
		const { code, events } = await runContract(harness, makeInput(ws));
		expect(events[0]).toMatchObject({ type: "started", harness: harness.name, harness_version: expect.stringMatching(/\S/) });
		const [first, second] = toolResults(events);
		expect(first).toMatchObject({ tool: SUBMIT, is_error: true });
		expect(first?.output_preview).toContain("attempt 1 of 3");
		for (const field of ["/summary", "/files", "/confidence", "additional properties"]) expect(first?.output_preview).toContain(field);
		expect(second).toMatchObject({ tool: SUBMIT, is_error: false });
		expect(terminal(events)).toMatchObject({ type: "result", output: GOOD, turns: 2 });
		expect(code).toBe(0);
	});

	it("drops tool-call markup a model leaks into a field, and shows it the arguments it couldn't parse", async () => {
		const ws = makeWorkspace();
		const leaked = { summary: 'All good.\n<parameter name="files">["README.md"]</parameter>' };
		const raw = '<parameter name="summary">All good.</parameter>';
		const unparsed = { calls: [{ name: SUBMIT, args: {}, argumentsError: `Unexpected token '<'\n\nReceived arguments:\n${raw}` }] };
		const trailing = { ...GOOD, summary: "All good.</summary>\n</invoke>" };
		const { code, events } = await runContract(make([call(SUBMIT, leaked), unparsed, call(SUBMIT, trailing)]), makeInput(ws));
		const [markup, malformed, accepted] = toolResults(events);
		expect(markup?.output_preview).toContain('/summary: contains tool-call markup (<parameter name="files">)');
		expect(markup?.output_preview).toContain("must have required properties files");
		expect(malformed).toMatchObject({ tool: SUBMIT, is_error: true });
		expect(malformed?.output_preview).toContain(raw);
		expect(accepted).toMatchObject({ tool: SUBMIT, is_error: false });
		expect(terminal(events)).toMatchObject({ type: "result", output: GOOD });
		expect(code).toBe(0);
	});

	it("keeps a valid submission's HTML and quoted XML exactly as written", async () => {
		const ws = makeWorkspace();
		const written = { ...GOOD, summary: '<details><summary>Results</summary>Set <parameter name="retries">3</parameter> in pom.xml.</details>' };
		const { code, events } = await runContract(make([call(SUBMIT, written)]), makeInput(ws));
		expect(terminal(events)).toMatchObject({ type: "result", output: written });
		expect(code).toBe(0);
	});

	it("stops after the last rejected submission and says what was wrong with it", async () => {
		const ws = makeWorkspace();
		const bad = call(SUBMIT, { summary: "ok summary", files: "README.md" });
		const { code, events } = await runContract(make([bad, bad, bad, call(SUBMIT, GOOD)]), makeInput(ws));
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
		const { code, events } = await runContract(
			make([...Array.from({ length: 5 }, () => call("ls", {})), call(SUBMIT, GOOD)]),
			makeInput(ws, { max_turns: 3 }),
		);
		expect(terminal(events)).toMatchObject({ type: "error", code: "max_turns", message: expect.stringContaining("turn limit (3)") });
		expect(toolResults(events)).toHaveLength(3);
		expect(code).toBe(1);
	});

	it("takes the key from stdin and keeps every secret out of the tool env and the output", async () => {
		const ws = makeWorkspace();
		const stdinKey = "sk-ant-test-STDINKEY-0123456789";
		process.env.ANTHROPIC_API_KEY = "sk-ant-test-ENVKEY-9876543210";
		process.env.ANTHROPIC_OAUTH_TOKEN = "oauth-token-value";
		process.env.OPENAI_API_KEY = "sk-openai-not-for-the-model";
		process.env.RENDER_API_KEY = "rnd-not-for-the-model";

		const harness = make([call("bash", { command: "env > $HOME/env.txt" }), call(SUBMIT, GOOD)]);
		const { code, stdout, events } = await runContract(harness, makeInput(ws, { tools: ["bash", "write"] }), stdinKey);

		expect(toolResults(events)[0]?.is_error).toBe(false);
		const env = readFileSync(join(ws.scratchDir, "env.txt"), "utf8");
		expect(env).toContain(`HOME=${ws.scratchDir}`);
		for (const leaked of ["sk-ant", "sk-openai", "ANTHROPIC", "OPENAI", "oauth-token-value", "RENDER_API_KEY", "rnd-not"])
			expect(env).not.toContain(leaked);
		expect(stdout).not.toContain(stdinKey);
		expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
		expect(code).toBe(0);
	});

	it("read-only agents: bash rejects git push, rm, and redirects into the checkout, and runs read-only commands", async () => {
		const ws = makeWorkspace();
		const { events } = await runContract(
			make([
				call("bash", { command: "git push origin main" }),
				call("bash", { command: "rm README.md" }),
				call("bash", { command: "echo hi > notes.txt" }),
				call("bash", { command: "git log -1 --format=%H > $HOME/head.txt" }),
				call("write", { path: "notes.txt", content: "not allowed" }),
				call(SUBMIT, GOOD),
			]),
			makeInput(ws),
		);
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
		const { events } = await runContract(
			make([
				call("write", { path: "src/new.ts", content: "export const added = true;\n" }),
				call("edit", { path: "src/app.ts", edits: [{ oldText: "41", newText: "42" }] }),
				call("bash", { command: "rm README.md && git status --porcelain > $HOME/status.txt" }),
				call("read", { path: "src/app.ts" }),
				call(SUBMIT, GOOD),
			]),
			makeInput(ws, { tools: ["read", "bash", "edit", "write"] }),
		);
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
	const allowed = [
		"rg -n 'a|b; c' src",
		"git --no-pager diff main...HEAD",
		"git -C src log -1",
		"git grep -c TODO",
		"timeout 60 go test ./...",
		"timeout -s KILL 30 git log",
		"env -u CI -C src git status",
		"xargs -I {} rg -n {} src",
		"sed -n 1,20p src/app.ts > /tmp/head.txt 2>&1",
		"cp -t $HOME src/app.ts",
		"mv /tmp/a /tmp/b",
		"sed -i s/41/42/ /tmp/app.ts",
		"echo hi | tee /tmp/out.txt",
		"toString install",
		"constructor add x",
	];
	const SCRATCH_ONLY = "only allowed on files in the scratch directory";
	const rejected: [command: string, reason: string][] = [
		["git push origin main", "git push is not allowed"],
		["bash -c 'git commit -am x'", "git commit is not allowed"],
		["env FOO=1 npm install left-pad", "npm install is not allowed"],
		["sudo ls", "sudo is not allowed"],
		["echo $(curl https://example.com)", "curl is not allowed"],
		["timeout --signal TERM -k 5 30 curl https://example.com", "curl is not allowed"],
		["env -C src curl https://example.com", "curl is not allowed"],
		["xargs -I {} curl {}", "curl is not allowed"],
		["git -c core.hooksPath=/tmp log", "git config overrides are not allowed"],
		["git -ccore.hooksPath=/tmp log", "git config overrides are not allowed"],
		["git -C src -c core.pager=x log", "git config overrides are not allowed"],
		["rm -rf src", SCRATCH_ONLY],
		["sed -i s/41/42/ src/app.ts", SCRATCH_ONLY],
		["cp -t src /tmp/app.ts", SCRATCH_ONLY],
		["cp --target-directory=src /tmp/app.ts", SCRATCH_ONLY],
		["mv -t /tmp src/app.ts", SCRATCH_ONLY],
		["chmod +x src/run.sh", SCRATCH_ONLY],
		["perl -pi -e s/41/42/ src/app.ts", SCRATCH_ONLY],
		["echo hi | tee src/out.txt", SCRATCH_ONLY],
	];

	it("lets inspection and test commands through, and rejects writes outside scratch, network tools, and git config overrides", () => {
		for (const command of allowed) expect(rejectReason(command, "/factory/scratch"), command).toBeUndefined();
		for (const [command, reason] of rejected) expect(rejectReason(command, "/factory/scratch"), command).toContain(reason);
	});
});
