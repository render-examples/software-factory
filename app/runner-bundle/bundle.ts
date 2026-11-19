import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const RUNNER_DIR = fileURLToPath(new URL("../runner/", import.meta.url));
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
		banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
		logLevel: "warning",
	});
	const [file] = result.outputFiles;
	if (!file) throw new Error("esbuild produced no output for the runner bundle");
	return { text: file.text, inputs: Object.keys(result.metafile.inputs) };
}

export async function bundleRunner(): Promise<string> {
	return (await buildBundle()).text;
}

export async function bundleInputs(): Promise<string[]> {
	return (await buildBundle()).inputs.map((input) => relative(REPO_ROOT, resolve(RUNNER_DIR, input)));
}
