import { mkdirSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { AGENTS, type Agent } from "../agents/index.js";
import { errorMessage } from "../util/index.js";
import { createEmitter } from "./core/emit.js";
import { parseInput } from "./core/input.js";
import { executeHarness } from "./core/kernel.js";
import { scrubKeys } from "./core/keys.js";
import { PROTOCOL_VERSION, RUNNER_EXIT } from "./core/protocol.js";

interface MainIO {
	stdin: AsyncIterable<string | Uint8Array>;
	write(chunk: string): Promise<void>;
	agents?: readonly Agent[];
}

const processIO = (): MainIO => ({
	stdin: process.stdin,
	write: (chunk) => new Promise((resolve, reject) => process.stdout.write(chunk, (err) => (err ? reject(err) : resolve()))),
});

function useScratch(scratchDir: string): void {
	mkdirSync(scratchDir, { recursive: true });
	process.env.TMPDIR = scratchDir;
}

export async function main(argv: string[], io: MainIO = processIO()): Promise<number> {
	const startedAt = Date.now();
	const agents = io.agents ?? AGENTS;
	const emit = createEmitter(io.write);
	const fail = async (code: "invalid_input" | "agent_error", message: string) => {
		emit({ type: "error", code, message });
		await emit.flush();
		return code === "invalid_input" ? RUNNER_EXIT.invalid_input : RUNNER_EXIT.error;
	};

	let args: { "key-stdin"?: boolean; "self-test"?: boolean };
	try {
		args = parseArgs({
			args: argv,
			options: {
				"key-stdin": { type: "boolean" },
				"self-test": { type: "boolean" },
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
	if (!apiKey) return fail("invalid_input", "no model key: pass it as the first line of stdin with --key-stdin");

	try {
		if (input.scratch_dir) useScratch(input.scratch_dir);
		return await executeHarness({ input, emit, apiKey, startedAt }, agent.harness);
	} catch (err) {
		console.error(err);
		if (!emit.terminated) return await fail("agent_error", errorMessage(err));
		return RUNNER_EXIT.error;
	} finally {
		await emit.flush();
	}
}

async function selfTest(io: MainIO, agents: readonly Agent[]): Promise<number> {
	const report = {
		ok: true,
		protocol_version: PROTOCOL_VERSION,
		node: process.version,
		agents: agents.map((a) => ({ id: a.id, harness: a.harness.name, label: a.harness.label })),
	};
	await io.write(`${JSON.stringify(report)}\n`);
	return RUNNER_EXIT.ok;
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
	setTimeout(() => process.exit(code), 1_000).unref();
}
