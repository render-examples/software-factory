import { mkdirSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { Agent } from "../agents/define.js";
import { AGENTS } from "../agents/registry.js";
import { createEmitter, errorMessage } from "./core/emit.js";
import { parseInput } from "./core/input.js";
import { scrubKeys } from "./core/keys.js";
import { PROTOCOL_VERSION, RUNNER_EXIT } from "./core/protocol.js";
import { defaultTestScript } from "./core/test-script.js";

interface MainIO {
	stdin: AsyncIterable<string | Uint8Array>;
	/** Resolves once `chunk` is flushed. */
	write(chunk: string): Promise<void>;
	/** Replaces the bundled agents (tests). */
	agents?: readonly Agent[];
}

const processIO = (): MainIO => ({
	stdin: process.stdin,
	write: (chunk) => new Promise((resolve, reject) => process.stdout.write(chunk, (err) => (err ? reject(err) : resolve()))),
});

/** Scratch is the only writable location besides cwd; the bash tool spills oversized output to os.tmpdir(). */
function useScratch(scratchDir: string): void {
	mkdirSync(scratchDir, { recursive: true });
	process.env.TMPDIR = scratchDir;
}

/**
 * `runner.mjs [--key-stdin] [--test-stub] [--self-test]`: RunnerInput on stdin, RunnerEvent JSONL on stdout. With
 * `--key-stdin`, the first line of stdin is the model key and the rest is the RunnerInput. The input's `agent_id`
 * selects the agent, and so its harness, from the bundle. Returns the exit code.
 */
export async function main(argv: string[], io: MainIO = processIO()): Promise<number> {
	const startedAt = Date.now();
	const agents = io.agents ?? AGENTS;
	const emit = createEmitter(io.write);
	const fail = async (code: "invalid_input" | "agent_error", message: string) => {
		emit({ type: "error", code, message });
		await emit.flush();
		return code === "invalid_input" ? RUNNER_EXIT.invalid_input : RUNNER_EXIT.error;
	};

	let args: { "key-stdin"?: boolean; "self-test"?: boolean; "test-stub"?: boolean };
	try {
		args = parseArgs({
			args: argv,
			options: {
				"key-stdin": { type: "boolean" },
				"self-test": { type: "boolean" },
				"test-stub": { type: "boolean" },
			},
		}).values;
	} catch (err) {
		return fail("invalid_input", errorMessage(err));
	}

	for (const secret of scrubKeys(
		process.env,
		agents.map((a) => a.harness.credential),
	))
		emit.redact(secret);
	// stdout carries only RunnerEvent JSONL; route any library console output to stderr.
	console.log = console.info = console.debug = console.error;

	let stdin: string | undefined;
	let apiKey: string | undefined;
	if (args["key-stdin"]) {
		const text = await readAll(io.stdin);
		const newline = text.indexOf("\n");
		apiKey = (newline === -1 ? text : text.slice(0, newline)).trim();
		emit.redact(apiKey);
		if (!apiKey) return fail("invalid_input", "--key-stdin: the first line of stdin is empty");
		stdin = newline === -1 ? "" : text.slice(newline + 1);
	}

	if (args["self-test"]) return selfTest(io, agents);

	let json: unknown;
	try {
		json = JSON.parse(stdin ?? (await readAll(io.stdin)));
	} catch (err) {
		return fail("invalid_input", `stdin is not valid JSON: ${errorMessage(err)}`);
	}
	const input = parseInput(json);
	if (typeof input === "string") return fail("invalid_input", input);
	const agent = agents.find((a) => a.id === input.agent_id);
	if (!agent) return fail("invalid_input", `unknown agent "${input.agent_id}": the runner bundle doesn't define it`);
	if (input.test_script && !args["test-stub"]) return fail("invalid_input", "test_script is only honored with --test-stub");

	try {
		if (input.scratch_dir) useScratch(input.scratch_dir);
		return await agent.harness.run({
			input,
			emit,
			apiKey,
			testScript: args["test-stub"] ? (input.test_script ?? defaultTestScript(input)) : undefined,
			startedAt,
		});
	} catch (err) {
		console.error(err);
		if (!emit.terminated) return await fail("agent_error", errorMessage(err));
		return RUNNER_EXIT.error;
	} finally {
		await emit.flush();
	}
}

/** Checks every bundled harness and prints one JSON line: `ok`, the protocol, and each harness's label and version. */
async function selfTest(io: MainIO, agents: readonly Agent[]): Promise<number> {
	const harnesses = [...new Map(agents.map((a) => [`${a.harness.name} ${a.harness.label}`, a.harness])).values()];
	const errors: string[] = [];
	const reported: { name: string; label: string; version: string }[] = [];
	for (const harness of harnesses) {
		try {
			const { version, problems } = await harness.selfTest();
			reported.push({ name: harness.name, label: harness.label, version });
			errors.push(...problems);
		} catch (err) {
			reported.push({ name: harness.name, label: harness.label, version: "unknown" });
			errors.push(`${harness.name}: ${errorMessage(err)}`);
		}
	}
	const ok = errors.length === 0;
	const report = {
		ok,
		protocol_version: PROTOCOL_VERSION,
		node: process.version,
		harnesses: reported,
		...(ok ? {} : { errors }),
	};
	await io.write(`${JSON.stringify(report)}\n`);
	return ok ? RUNNER_EXIT.ok : RUNNER_EXIT.error;
}

async function readAll(stream: AsyncIterable<string | Uint8Array>): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of stream) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks).toString("utf8");
}

function isEntryPoint(): boolean {
	try {
		return !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
	} catch {
		return false;
	}
}

if (isEntryPoint()) {
	const code = await main(process.argv.slice(2));
	process.exitCode = code;
	// Output is flushed; don't let lingering keep-alive sockets or timers in the provider SDKs hold the process open.
	setTimeout(() => process.exit(code), 1_000).unref();
}
