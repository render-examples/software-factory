/**
 * Step 2 of setup, after the GitHub App exists and before the Blueprint is applied: create the Render environment
 * groups that render.yaml links, so the Blueprint deploys without asking for any value. Idempotent; never prints
 * a secret.
 *
 *   npm run setup:render [-- --workspace tea-…]
 *
 * Reads RENDER_API_KEY, RENDER_WORKSPACE_ID, the GitHub App values, and ANTHROPIC_API_KEY from the environment
 * or .env. Generates EVENTS_READ_TOKEN when .env has none and saves it there first, so a rerun keeps it.
 * --workspace overrides RENDER_WORKSPACE_ID and, after a successful run, saves it to .env.
 */

import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { config } from "../app/config/index.js";
import { writeEnvFile } from "./lib/env-file.js";
import { errorMessage, Reporter } from "./lib/output.js";
import { setupRenderWithPreflight } from "./lib/preflight.js";
import { newEventsReadToken } from "./lib/setup-render.js";

const { values } = parseArgs({ options: { workspace: { type: "string" } } });
const workspace = values.workspace?.trim();

const out = new Reporter();
try {
	const token = newEventsReadToken(process.env);
	if (token) {
		await writeEnvFile(".env", { EVENTS_READ_TOKEN: token });
		out.line("Generated EVENTS_READ_TOKEN, the reader token for event streams, and saved it to .env");
	}
	const env = { ...process.env, ...(token ? { EVENTS_READ_TOKEN: token } : {}), ...(workspace ? { RENDER_WORKSPACE_ID: workspace } : {}) };
	const requiredNodeMajor = Number.parseInt(await readFile(new URL("../.node-version", import.meta.url), "utf8"), 10);
	process.exitCode = await setupRenderWithPreflight({ env, repos: config.repos, nodeVersion: process.versions.node, requiredNodeMajor }, out);
	if (workspace && process.exitCode === 0) {
		await writeEnvFile(".env", { RENDER_WORKSPACE_ID: workspace });
		out.line(`Saved RENDER_WORKSPACE_ID=${workspace} to .env`);
	}
} catch (error) {
	out.fail(errorMessage(error));
	process.exitCode = 1;
}
