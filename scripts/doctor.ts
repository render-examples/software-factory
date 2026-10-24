/**
 * Read-only checks of a deployment. Never prints a secret; exits 1 when any check fails.
 *
 *   npm run doctor [-- --service gateway|workflows|all]
 *
 * Checks the environment it runs in: locally that's .env; in a service's Render Shell it's that service's env.
 */
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { config } from "../app/config/index.js";
import { runDoctor } from "./lib/doctor.js";
import { errorMessage, Reporter } from "./lib/output.js";
import type { Service } from "./lib/requirements.js";

const { values } = parseArgs({ options: { service: { type: "string", default: "all" } } });

const SELECTIONS: Record<string, Service[]> = {
	gateway: ["gateway"],
	workflows: ["workflows"],
	all: ["gateway", "workflows"],
};
const services = SELECTIONS[values.service ?? "all"];
if (!services) {
	console.error("--service must be gateway, workflows, or all");
	process.exit(2);
}

const sqlDir = join(dirname(fileURLToPath(import.meta.url)), "..", "app", "sql");
const migrations = (await readdir(sqlDir)).filter((name) => name.endsWith(".sql")).sort();

const out = new Reporter();
try {
	process.exitCode = await runDoctor({ env: process.env, services, repos: Object.keys(config.repos), models: config.models, migrations }, out);
} catch (error) {
	out.fail(`doctor crashed: ${errorMessage(error)}`);
	process.exitCode = 1;
}
