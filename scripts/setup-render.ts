/**
 * Step 2 of setup, after the GitHub App exists and before the Blueprint is applied: create the Render environment
 * groups that render.yaml links, so the Blueprint deploys without asking for any value. Idempotent; never prints
 * a secret.
 *
 *   npm run setup:render [-- --workspace tea-…]
 *
 * Reads RENDER_API_KEY, RENDER_WORKSPACE_ID, the GitHub App values, and ANTHROPIC_API_KEY from the environment
 * or .env. --workspace overrides RENDER_WORKSPACE_ID and, after a successful run, saves it to .env.
 */
import { parseArgs } from "node:util";
import { writeEnvFile } from "./lib/env-file.js";
import { errorMessage, Reporter } from "./lib/output.js";
import { setupRender } from "./lib/setup-render.js";

const { values } = parseArgs({ options: { workspace: { type: "string" } } });
const workspace = values.workspace?.trim();

const out = new Reporter();
try {
	const env = workspace ? { ...process.env, RENDER_WORKSPACE_ID: workspace } : process.env;
	process.exitCode = await setupRender({ env }, out);
	if (workspace && process.exitCode === 0) {
		await writeEnvFile(".env", { RENDER_WORKSPACE_ID: workspace });
		out.line(`Saved RENDER_WORKSPACE_ID=${workspace} to .env`);
	}
} catch (error) {
	out.fail(errorMessage(error));
	process.exitCode = 1;
}
