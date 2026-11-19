import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { config } from "../app/config/index.js";
import { writeEnvFile } from "./lib/env-file.js";
import { errorMessage, Reporter } from "./lib/output.js";
import { setupRenderWithPreflight } from "./lib/preflight.js";
import { linkDatabase, newEventsReadToken } from "./lib/setup-render.js";

const { values } = parseArgs({ options: { workspace: { type: "string" }, "link-database": { type: "boolean" } } });
const workspace = values.workspace?.trim();

const out = new Reporter();
try {
	if (values["link-database"]) {
		process.exitCode = await linkDatabase({ env: { ...process.env, ...(workspace ? { RENDER_WORKSPACE_ID: workspace } : {}) } }, out);
	} else {
		const token = newEventsReadToken(process.env);
		if (token) {
			await writeEnvFile(".env", { EVENTS_READ_TOKEN: token });
			out.line("Generated EVENTS_READ_TOKEN, the reader token for event streams, and saved it to .env");
		}
		const env = { ...process.env, ...(token ? { EVENTS_READ_TOKEN: token } : {}), ...(workspace ? { RENDER_WORKSPACE_ID: workspace } : {}) };
		const requiredNodeMajor = Number.parseInt(await readFile(new URL("../.node-version", import.meta.url), "utf8"), 10);
		process.exitCode = await setupRenderWithPreflight({ env, repos: config.repos, nodeVersion: process.versions.node, requiredNodeMajor }, out);
	}
	if (workspace && process.exitCode === 0) {
		await writeEnvFile(".env", { RENDER_WORKSPACE_ID: workspace });
		out.line(`Saved RENDER_WORKSPACE_ID=${workspace} to .env`);
	}
} catch (error) {
	out.fail(errorMessage(error));
	process.exitCode = 1;
}
