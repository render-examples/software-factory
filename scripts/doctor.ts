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

const out = new Reporter();
try {
	process.exitCode = await runDoctor(
		{
			env: process.env,
			services,
			repos: Object.keys(config.repos),
			baseBranches: Object.fromEntries(Object.entries(config.repos).map(([name, repo]) => [name, repo.baseBranch])),
		},
		out,
	);
} catch (error) {
	out.fail(`doctor crashed: ${errorMessage(error)}`);
	process.exitCode = 1;
}
