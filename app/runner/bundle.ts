import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const RUNNER_DIR = fileURLToPath(new URL(".", import.meta.url));

/**
 * Bundles app/runner/main.ts and every package it uses into one self-contained ESM file, so the sandbox
 * needs only Node to run it: no npm, no node_modules.
 */
export async function bundleRunner(): Promise<string> {
	const result = await build({
		absWorkingDir: RUNNER_DIR,
		entryPoints: ["main.ts"],
		outfile: "runner.mjs",
		write: false,
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node22",
		// Bundled CommonJS dependencies call require() for Node built-ins, which ESM doesn't define.
		banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
		logLevel: "warning",
	});
	const [file] = result.outputFiles;
	if (!file) throw new Error("esbuild produced no output for the runner bundle");
	return file.text;
}
