import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const RUNNER_DIR = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

async function buildBundle(): Promise<{ text: string; inputs: string[] }> {
	const result = await build({
		absWorkingDir: RUNNER_DIR,
		entryPoints: ["main.ts"],
		outfile: "runner.mjs",
		write: false,
		bundle: true,
		metafile: true,
		platform: "node",
		format: "esm",
		target: "node22",
		// The cursor harness loads the SDK from the sandbox's provisioned install: its default build lazy-loads its own
		// chunks, which a single-file bundle can't hold.
		external: ["@cursor/sdk"],
		// Bundled CommonJS dependencies call require() for Node built-ins, which ESM doesn't define.
		banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
		logLevel: "warning",
	});
	const [file] = result.outputFiles;
	if (!file) throw new Error("esbuild produced no output for the runner bundle");
	return { text: file.text, inputs: Object.keys(result.metafile.inputs) };
}

/**
 * Bundles app/runner/main.ts, the agent registry with every harness it uses, and every package they need into one
 * self-contained ESM file, so the sandbox needs only Node to run it: no npm, no node_modules.
 */
export async function bundleRunner(): Promise<string> {
	return (await buildBundle()).text;
}

/** The source files in the bundle, relative to the repository root (tests check the sandbox's import boundary). */
export async function bundleInputs(): Promise<string[]> {
	return (await buildBundle()).inputs.map((input) => relative(REPO_ROOT, resolve(RUNNER_DIR, input)));
}
