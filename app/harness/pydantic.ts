import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { pydanticSelfTest, runPydantic } from "../runner/pydantic/run.js";
import type { Harness, HarnessProvision } from "./types.js";

export interface PydanticOptions {
	/** The agent module, relative to python/. It builds an agent with Pydantic AI and calls `serve(agent)`. */
	module: string;
	/**
	 * The env var that holds the key on the Workflows service, e.g. ANTHROPIC_API_KEY. The wrapper sets the same var in
	 * its own process for the agent's provider, so use the name the provider reads.
	 */
	credential: string;
}

/**
 * Builds the root-owned virtual environment beside the bundle (APP_DIR/python-env) from the hash-pinned
 * requirements, with the base image's python3 and pip. Replaces any previous environment only once the new one is
 * complete.
 */
const PYTHON_ENV_COMMAND = [
	"set -euo pipefail",
	`python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' || { echo "the pydantic harness needs python3 3.11 or later" >&2; exit 1; }`,
	"rm -rf ../python-env.next",
	"python3 -m venv --without-pip ../python-env.next",
	"python3 -m pip --python ../python-env.next/bin/python install --quiet --no-input --no-cache-dir --disable-pip-version-check --no-deps --require-hashes -r python/requirements.txt",
	"chown -R root:root ../python-env.next",
	"chmod -R a+rX,go-w ../python-env.next",
	"rm -rf ../python-env",
	"mv ../python-env.next ../python-env",
].join("\n");

/** The Python sources shipped to the sandbox: the wrapper, every agent module, and the locked requirements. */
function pythonProvision(): HarnessProvision {
	const root = fileURLToPath(new URL("../../python/", import.meta.url));
	const sources = (dir: string): string[] =>
		readdirSync(join(root, dir), { recursive: true, withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith(".py"))
			.map((entry) => relative(root, join(entry.parentPath, entry.name)));
	const files = [...sources("factory_harness"), ...sources("agents"), "requirements.txt"]
		.sort()
		.map((path) => ({ path: `python/${path}`, source: join(root, path) }));
	const requirements = readFileSync(join(root, "requirements.txt"));
	return { id: "pydantic-python", files, command: PYTHON_ENV_COMMAND, hash: createHash("sha256").update(requirements).digest("hex") };
}

/**
 * Runs an agent on a Pydantic AI agent defined in Python. The model and library options come from the module; the
 * factory supplies the prompt, its own tools over MCP, the submit tool, and the limits.
 */
export function pydantic(opts: PydanticOptions): Harness {
	if (!/^[A-Za-z0-9_][A-Za-z0-9_/.-]*\.py$/.test(opts.module) || opts.module.split("/").includes("..")) {
		throw new Error(`pydantic: module must be a .py path inside python/, got ${JSON.stringify(opts.module)}`);
	}
	if (!/^[A-Z][A-Z0-9_]*$/.test(opts.credential)) {
		throw new Error(`pydantic: credential must be an env var name, got ${JSON.stringify(opts.credential)}`);
	}
	return {
		name: "pydantic",
		label: `python/${opts.module}`,
		credential: opts.credential,
		provision: pythonProvision,
		run: (run) => runPydantic(run, { module: opts.module, keyEnv: opts.credential }),
		selfTest: () => pydanticSelfTest(opts.module),
	};
}
