/** Read-only local/runtime or pre-deployment prerequisite checks. */
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { config } from "../app/config/index.js";
import { Reporter } from "./lib/output.js";
import { runPreflight } from "./lib/preflight.js";

const { values } = parseArgs({ options: { local: { type: "boolean" }, workspace: { type: "string" } } });
const requiredNodeMajor = Number.parseInt(await readFile(new URL("../.node-version", import.meta.url), "utf8"), 10);
const env = values.workspace ? { ...process.env, RENDER_WORKSPACE_ID: values.workspace.trim() } : process.env;
process.exitCode = await runPreflight(
	{ env, repos: config.repos, nodeVersion: process.versions.node, requiredNodeMajor, local: values.local },
	new Reporter(),
);
