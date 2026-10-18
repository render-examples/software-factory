import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type AssistantMessage, type Context, fauxAssistantMessage, type StreamOptions } from "@earendil-works/pi-ai";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { sampleFromSchema } from "../app/runner/faux.js";
import { apiKeyFor, takeCredentials } from "../app/runner/keys.js";
import { checkSubmission, outputSchemaProblem } from "../app/runner/submit.js";
import { rejectReason, splitCommands } from "../app/runner/tools.js";
import {
	buildRunner,
	call,
	calls,
	GOOD,
	makeInput,
	makeWorkspace,
	OUTPUT_SCHEMA,
	parseEvents,
	runCli,
	runScripted,
	SUBMIT,
	say,
	terminal,
	toolResults,
} from "./helpers/runner.js";

/** Optional native accelerators `debug` and `ws` require inside try blocks; they fall back without them. */
const OPTIONAL_REQUIRES = new Set(["supports-color", "bufferutil", "utf-8-validate"]);

/** A scripted step that counts model requests actually made (a request on an aborted signal never leaves the process). */
const countingStep = (counter: { requests: number }, step: AssistantMessage) => (_context: Context, options: StreamOptions | undefined) => {
	if (!options?.signal?.aborted) counter.requests++;
	return step;
};

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
	it("--faux lists the working directory and submits a value built from the output schema", () => {
		const ws = makeWorkspace();
		const { code, stdout, stderr } = runCli(["--faux"], JSON.stringify(makeInput(ws)));
		const events = parseEvents(stdout);
		expect(events[0]).toEqual({ type: "started", at: expect.any(String), agent_id: "test-agent", model: "faux/faux", pi_version: "0.83.0" });
		expect(toolResults(events).map((r) => [r.tool, r.is_error])).toEqual([
			["ls", false],
			[SUBMIT, false],
		]);
		expect(toolResults(events)[0]?.output_preview.split("\n")).toEqual([".git/", "README.md", "src/"]);
		expect(terminal(events)).toMatchObject({ type: "result", output: { summary: "[faux]", files: [] }, turns: 2 });
		expect(code, stderr).toBe(0);
	});

	it("runs an agent with no tools and no cwd: the model gets only submit", () => {
		const { code, stdout } = runCli(["--faux"], JSON.stringify(makeInput(undefined)));
		const events = parseEvents(stdout);
		expect(toolResults(events).map((r) => r.tool)).toEqual([SUBMIT]);
		expect(terminal(events).type).toBe("result");
		expect(code).toBe(0);
	});

	it("deletes the --key-file and never echoes the key", () => {
		const ws = makeWorkspace();
		const keyFile = join(ws.scratchDir, "..", "model.key");
		const key = "sk-ant-test-cli-0123456789abcdef";
		writeFileSync(keyFile, `${key}\n`);
		const { code, stdout, stderr } = runCli(["--faux", "--key-file", keyFile], JSON.stringify(makeInput(ws)));
		expect(code).toBe(0);
		expect(existsSync(keyFile)).toBe(false);
		expect(stdout + stderr).not.toContain(key);
	});

	it("rejects invalid input with invalid_input and exit 2", () => {
		const ws = makeWorkspace();
		const cases = [
			"{nope",
			JSON.stringify({ ...makeInput(ws), model: "claude-imaginary-9" }),
			JSON.stringify({ ...makeInput(ws), message: undefined }),
			JSON.stringify({ ...makeInput(ws), output_schema: { type: "array", items: { type: "string" } } }),
			JSON.stringify({ ...makeInput(ws), output_schema: { anyOf: [{ type: "object", properties: {} }] } }),
			JSON.stringify({ ...makeInput(ws), output_schema: { type: "object" } }),
			JSON.stringify({ ...makeInput(ws), cwd: undefined }),
			JSON.stringify({ ...makeInput(ws), cwd: join(ws.cwd, "missing") }),
		];
		for (const stdin of cases) {
			const { code, stdout } = runCli(["--faux"], stdin);
			expect(terminal(parseEvents(stdout)), stdin).toMatchObject({ type: "error", code: "invalid_input" });
			expect(code).toBe(2);
		}
	});

	it("fails with agent_error when no API key is available outside --faux", () => {
		const { code, stdout } = runCli([], JSON.stringify(makeInput(makeWorkspace())));
		expect(terminal(parseEvents(stdout))).toMatchObject({ type: "error", code: "agent_error", message: expect.stringContaining("no API key") });
		expect(code).toBe(1);
	});

	it("--self-test reports versions without input or network", () => {
		const { code, stdout } = runCli(["--self-test"], "");
		expect(JSON.parse(stdout)).toEqual({ ok: true, pi_version: "0.83.0", node: process.version });
		expect(code).toBe(0);
	});

	it("is one self-contained file that imports only Node built-ins", () => {
		expect(readdirSync(runnerDir)).toEqual(["runner.mjs"]);
		const code = readFileSync(join(runnerDir, "runner.mjs"), "utf8");
		const staticImports = [...code.matchAll(/^\s*import\b[^;]*?\bfrom\s*["']([^"']+)["']/gm)].map((m) => m[1] as string);
		const bareImports = [...code.matchAll(/^\s*import\s*["']([^"']+)["']/gm)].map((m) => m[1] as string);
		const dynamicImports = [...code.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1] as string);
		const requires = [...code.matchAll(/\b__require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1] as string);
		expect(staticImports.length).toBeGreaterThan(0);
		expect([...staticImports, ...bareImports, ...dynamicImports, ...requires].filter((spec) => !isBuiltin(spec) && !OPTIONAL_REQUIRES.has(spec))).toEqual([]);
		for (const spec of OPTIONAL_REQUIRES) {
			for (const m of code.matchAll(new RegExp(`__require\\("${spec}"\\)`, "g"))) expect(code.slice(Math.max(0, m.index - 80), m.index)).toMatch(/try\s*\{/);
		}
	});
});

describe("submit", { timeout: 30_000 }, () => {
	it("accepts a valid submission and ends the run", async () => {
		const ws = makeWorkspace();
		let extraCalls = 0;
		const { code, events } = await runScripted(makeInput(ws), () => [
			call(SUBMIT, GOOD),
			() => {
				extraCalls++;
				return say("NEVER");
			},
		]);
		expect(terminal(events)).toEqual({ type: "result", at: expect.any(String), output: GOOD, turns: 1 });
		expect(extraCalls).toBe(0);
		expect(code).toBe(0);
	});

	it("returns every problem to the model, and accepts the corrected submission", async () => {
		const ws = makeWorkspace();
		const { code, events } = await runScripted(makeInput(ws), () => [
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

	it("does not let Pi coerce a submission: a numeric string for an integer is rejected", async () => {
		const schema = { type: "object", properties: { n: { type: "integer" } }, required: ["n"] };
		const { events } = await runScripted(makeInput(undefined, { output_schema: schema }), () => [call(SUBMIT, { n: "3" }), call(SUBMIT, { n: 3 })]);
		expect(toolResults(events).map((r) => r.is_error)).toEqual([true, false]);
		expect(terminal(events)).toMatchObject({ type: "result", output: { n: 3 } });
	});

	it("gives up with invalid_submission after three rejected submissions", async () => {
		const ws = makeWorkspace();
		const bad = { summary: "x", files: [] };
		const extra = { requests: 0 };
		const { code, events } = await runScripted(makeInput(ws), () => [
			call(SUBMIT, bad),
			call(SUBMIT, bad),
			call(SUBMIT, bad),
			countingStep(extra, call(SUBMIT, GOOD)),
		]);
		expect(toolResults(events).map((r) => r.is_error)).toEqual([true, true, true]);
		expect(toolResults(events).at(-1)?.output_preview).toContain("No attempts remain");
		expect(terminal(events)).toMatchObject({ type: "error", code: "invalid_submission" });
		expect(extra.requests).toBe(0);
		expect(code).toBe(1);
	});

	it("shows the model the output schema as the submit tool's parameters, and only submit without tools", async () => {
		let seen: Context["tools"];
		await runScripted(makeInput(undefined), () => [
			(context) => {
				seen = context.tools;
				return call(SUBMIT, GOOD);
			},
		]);
		expect(seen?.map((t) => t.name)).toEqual([SUBMIT]);
		expect(seen?.[0]?.parameters).toMatchObject({ type: "object", properties: OUTPUT_SCHEMA.properties, required: ["summary", "files"] });
		expect(seen?.[0]?.parameters).not.toHaveProperty("$schema");
	});

	it("ends on a submission batched with another call, without another model request", async () => {
		const ws = makeWorkspace();
		let extraCalls = 0;
		const { events } = await runScripted(makeInput(ws), () => [
			calls(["ls", {}], [SUBMIT, GOOD]),
			() => {
				extraCalls++;
				return say("NEVER");
			},
		]);
		expect(toolResults(events).map((r) => [r.tool, r.is_error])).toEqual([
			["ls", false],
			[SUBMIT, false],
		]);
		expect(terminal(events).type).toBe("result");
		expect(extraCalls).toBe(0);
	});
});

describe("run limits", { timeout: 30_000 }, () => {
	it("reminds the model once when it stops without submitting", async () => {
		const ws = makeWorkspace();
		const answered = await runScripted(makeInput(ws), () => [say("Here is my answer in prose."), call(SUBMIT, GOOD)]);
		expect(terminal(answered.events)).toMatchObject({ type: "result", turns: 2 });

		const silent = await runScripted(makeInput(ws), () => [say("prose"), say("more prose")]);
		expect(terminal(silent.events)).toMatchObject({ type: "error", code: "no_submission" });
		expect(silent.code).toBe(1);
	});

	it("stops after max_turns without a submission", async () => {
		const ws = makeWorkspace();
		const { code, events } = await runScripted(makeInput(ws, { max_turns: 3 }), () => [
			...Array.from({ length: 5 }, () => call("ls", {})),
			call(SUBMIT, GOOD),
		]);
		expect(terminal(events)).toMatchObject({ type: "error", code: "max_turns", message: expect.stringContaining("turn limit (3)") });
		expect(toolResults(events)).toHaveLength(3);
		expect(code).toBe(1);
	});

	it("stops with budget_exceeded once the model cost reaches budget_usd, before the call's tools run", async () => {
		const ws = makeWorkspace();
		const { code, events } = await runScripted(makeInput(ws, { budget_usd: 0.000001 }), () => [call("bash", { command: "touch $HOME/ran" }), call(SUBMIT, GOOD)]);
		expect(events.find((e) => e.type === "usage")).toMatchObject({ usage: { cost_usd: expect.any(Number) } });
		expect(terminal(events)).toMatchObject({ type: "error", code: "budget_exceeded" });
		expect(toolResults(events)).toMatchObject([{ tool: "bash", is_error: true, output_preview: expect.stringContaining("aborted") }]);
		expect(existsSync(join(ws.scratchDir, "ran"))).toBe(false);
		expect(code).toBe(1);
	});

	it("still accepts a submission made in the call that crosses the budget", async () => {
		const ws = makeWorkspace();
		const { events } = await runScripted(makeInput(ws, { budget_usd: 0.000001 }), () => [call(SUBMIT, GOOD)]);
		expect(terminal(events)).toMatchObject({ type: "result", output: GOOD });
	});

	it("aborts at the deadline with timeout and exit 3", async () => {
		const ws = makeWorkspace();
		const startedAt = Date.now();
		const { code, events } = await runScripted(makeInput(ws, { timeout_ms: 2_000 }), () =>
			Array.from({ length: 5 }, () => call("bash", { command: "sleep 5" })),
		);
		expect(terminal(events)).toMatchObject({ type: "error", code: "timeout" });
		expect(code).toBe(3);
		expect(Date.now() - startedAt).toBeLessThan(5_000);
	});

	it("maps a model error to agent_error, and retries a transient one", async () => {
		const ws = makeWorkspace();
		const fatal = await runScripted(makeInput(ws), () => [
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "authentication_error: invalid x-api-key" }),
		]);
		expect(terminal(fatal.events)).toMatchObject({ type: "error", code: "agent_error", message: expect.stringContaining("invalid x-api-key") });

		const overloaded = fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error: Overloaded" });
		const retried = await runScripted(makeInput(ws), () => [call("ls", {}), overloaded, call(SUBMIT, GOOD)]);
		expect(toolResults(retried.events).map((r) => r.tool)).toEqual(["ls", SUBMIT]);
		expect(terminal(retried.events).type).toBe("result");
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

		const { code, stdout, events } = await runScripted(
			makeInput(ws, { tools: ["bash", "write"] }),
			() => [call("bash", { command: `(test -e ${keyFile} && echo KEY_FILE_PRESENT || echo KEY_FILE_ABSENT; env) > $HOME/env.txt` }), call(SUBMIT, GOOD)],
			["--key-file", keyFile],
		);

		expect(toolResults(events)[0]?.is_error).toBe(false);
		const env = readFileSync(join(ws.scratchDir, "env.txt"), "utf8");
		expect(env).toContain("KEY_FILE_ABSENT");
		expect(env).toContain(`HOME=${ws.scratchDir}`);
		for (const leaked of ["sk-ant", "sk-openai", "ANTHROPIC", "OPENAI", "oauth-token-value", "RENDER_API_KEY", "rnd-not"]) expect(env).not.toContain(leaked);
		expect(stdout).not.toContain(fileKey);
		expect(existsSync(keyFile)).toBe(false);
		expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
		expect(code).toBe(0);
	});

	it("prefers the key file, else the selected provider's own var, and removes every provider's vars", () => {
		const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: " sk-ant-env ", ANTHROPIC_AUTH_TOKEN: "bearer", OPENAI_API_KEY: "sk-openai", PATH: "/bin" };
		const creds = takeCredentials(undefined, env);
		expect(env).toEqual({ PATH: "/bin" });
		expect(apiKeyFor(creds, "anthropic")).toBe("sk-ant-env");
		expect(apiKeyFor(creds, "openai")).toBe("sk-openai");
		expect(apiKeyFor(creds, "google")).toBeUndefined();
		expect(apiKeyFor({ ...creds, fileKey: "from-file" }, "anthropic")).toBe("from-file");
	});
});

describe("tools", { timeout: 30_000 }, () => {
	it("read-only agents: bash rejects git push and rm, and runs read-only commands", async () => {
		const ws = makeWorkspace();
		const { events } = await runScripted(makeInput(ws), () => [
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
		const { events } = await runScripted(makeInput(ws, { tools: ["read", "bash", "edit", "write"] }), () => [
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

	it("offers only the tools the input names", async () => {
		const ws = makeWorkspace();
		let seen: string[] = [];
		const { events } = await runScripted(makeInput(ws, { tools: ["read"] }), () => [
			(context) => {
				seen = context.tools?.map((t) => t.name) ?? [];
				return call("bash", { command: "ls" });
			},
			call(SUBMIT, GOOD),
		]);
		expect(seen).toEqual(["read", SUBMIT]);
		expect(toolResults(events)[0]).toMatchObject({ tool: "bash", is_error: true, output_preview: expect.stringContaining("not found") });
	});
});

const ctx = { scratchDir: "/scratch" };

describe("read-only shell policy", () => {
	it.each([
		"git push origin main",
		"git checkout -b evil",
		"git log -1; git push origin main",
		"FOO=1 git commit -am x",
		"git -c core.fsmonitor=evil status",
		"git branch evil",
		"git config --global user.name x",
		"rm README.md",
		"rm -rf /scratch/../repo",
		"mv a b",
		"cp /scratch/x src/x",
		"touch new.txt",
		"mkdir build",
		"sed -i s/a/b/ src/app.ts",
		"echo x > notes.txt",
		"echo x >> src/app.ts",
		"cat a | tee out.txt",
		"curl https://example.com",
		'echo "$(wget -qO- https://example.com)"',
		'bash -c "rm -rf src"',
		"npm install left-pad",
		"sudo ls",
		"chmod -R 777 .",
	])("rejects %s", (command) => {
		expect(rejectReason(command, ctx)).toBeDefined();
	});

	it.each([
		"git log -1",
		"git status",
		"git branch -a",
		"git diff HEAD~1 --stat | head -20",
		'rg -n "curl|rm -rf" .',
		"grep -rn 'git push' .",
		"env > $HOME/env.txt",
		"npm test 2>&1 | tail -20",
		"ls missing 2>/dev/null || true",
		"cp README.md /scratch/readme.txt",
		"mkdir -p $TMPDIR/out",
		"touch /tmp/marker",
		"sed -n 1,5p README.md",
		"chmod +x /scratch/check.sh",
		"python3 -c 'print(1)'",
	])("allows %s", (command) => {
		expect(rejectReason(command, ctx)).toBeUndefined();
	});

	it("splits substitutions and quotes the way a shell would, keeping fd redirections whole", () => {
		expect(splitCommands(`echo "x $(git push) y" | rg 'a|b'`)).toEqual([["echo", "x "], ["git", "push"], [" y"], ["rg", "a|b"]]);
		expect(splitCommands("npm test 2>&1 &> out.txt")).toEqual([["npm", "test", "2>&1", "&>", "out.txt"]]);
	});
});

describe("output schema checks", () => {
	const Output = z.object({
		title: z.string().min(1),
		kind: z.enum(["bug", "feature"]),
		steps: z.array(z.object({ n: z.number().int(), text: z.string() })).min(1),
		owner: z.string().nullable(),
		notes: z.string().optional(),
		priority: z.number().default(2),
	});
	const schema = z.toJSONSchema(Output, { io: "input" }) as Record<string, unknown>;

	it("TypeBox validates the JSON Schema z.toJSONSchema emits", () => {
		expect(outputSchemaProblem(schema)).toBeUndefined();
		expect(checkSubmission(schema, { title: "t", kind: "bug", steps: [{ n: 1, text: "x" }], owner: null })).toEqual({ ok: true });
		const verdict = checkSubmission(schema, { title: "", kind: "chore", steps: [{ n: 1.5, text: "x" }], owner: 3, notes: 1 });
		expect(verdict.ok).toBe(false);
		const problems = verdict.ok ? [] : verdict.problems.join("\n");
		for (const path of ["/title", "/kind", "/steps/0/n", "/owner", "/notes"]) expect(problems).toContain(path);
		expect(checkSubmission(schema, { title: "t", kind: "bug", steps: [], owner: null }).ok).toBe(false);
	});

	it("faux samples satisfy the schema", () => {
		expect(checkSubmission(schema, sampleFromSchema(schema))).toEqual({ ok: true });
		expect(Output.safeParse(sampleFromSchema(schema)).success).toBe(true);
	});

	it("requires a plain object schema at the root", () => {
		expect(outputSchemaProblem({ type: "array" })).toMatch(/type "object"/);
		expect(outputSchemaProblem({ type: "object" })).toMatch(/properties/);
		expect(outputSchemaProblem(z.toJSONSchema(z.union([z.object({ a: z.string() }), z.object({ b: z.string() })])) as Record<string, unknown>)).toBeDefined();
	});
});

/** The only packages runner code may use; everything it imports ends up in the sandbox bundle. */
const RUNNER_PACKAGES = new Set(["@earendil-works/pi-agent-core", "@earendil-works/pi-ai", "typebox", "zod"]);
const RUNNER_DIR = fileURLToPath(new URL("../app/runner/", import.meta.url));

describe("runner import boundary", () => {
	it("files under app/runner/ (except bundle.ts) import only each other, Node built-ins, or the runner packages", () => {
		const violations: string[] = [];
		for (const file of readdirSync(RUNNER_DIR).filter((f) => f.endsWith(".ts") && f !== "bundle.ts")) {
			const code = readFileSync(join(RUNNER_DIR, file), "utf8");
			for (const [, spec] of code.matchAll(/from\s+["']([^"']+)["']/g)) {
				if (!spec || spec.startsWith("node:") || spec.startsWith("./")) continue;
				const pkg = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : (spec.split("/")[0] as string);
				if (!RUNNER_PACKAGES.has(pkg)) violations.push(`${file}: ${spec}`);
			}
		}
		expect(violations).toEqual([]);
	});
});
