import { statSync } from "node:fs";
import { PROTOCOL_VERSION, RunnerInput } from "./protocol.js";
import { outputSchemaProblem } from "./submit.js";

/** Validates a RunnerInput, including what Zod can't see: the protocol version, the output schema's root, and the directories. */
export function parseInput(json: unknown): RunnerInput | string {
	const version = (json as { protocol_version?: unknown } | null)?.protocol_version;
	if (version !== PROTOCOL_VERSION) {
		return `this runner speaks protocol ${PROTOCOL_VERSION}, but the input is protocol ${JSON.stringify(version ?? null)}: the host and the runner bundle are from different versions`;
	}
	const parsed = RunnerInput.safeParse(json);
	if (!parsed.success) {
		return `invalid RunnerInput: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`;
	}
	const input = parsed.data;
	const schemaProblem = outputSchemaProblem(input.output_schema);
	if (schemaProblem) return schemaProblem;
	if (input.tools.length > 0) {
		if (!input.cwd) return "cwd is required when tools is non-empty";
		if (!input.scratch_dir) return "scratch_dir is required when tools is non-empty";
		if (!isDirectory(input.cwd)) return `cwd ${input.cwd} is not a directory`;
	}
	return input;
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}
