/**
 * Step 1 of setup: create the factory's GitHub App with GitHub's manifest flow, before anything is deployed.
 *
 *   npm run setup:app [-- --org <org>] [--name <name>] [--write-env]
 *
 * The App's webhook starts inactive at a placeholder URL; `npm run setup:github` points it at the gateway once the
 * Blueprint is deployed. Prints the values the Blueprint form asks for.
 */
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { config } from "../app/config/index.js";
import { writeEnvFile } from "./lib/env-file.js";
import { githubApiUrlFrom, githubWebUrl } from "./lib/github.js";
import {
	buildManifest,
	exchangeManifestCode,
	formPage,
	newState,
	registrationUrl,
	startCallbackServer,
} from "./lib/manifest.js";
import { bold, dim, errorMessage, green, yellow } from "./lib/output.js";

const { values } = parseArgs({
	options: {
		org: { type: "string" },
		name: { type: "string" },
		port: { type: "string" },
		"write-env": { type: "boolean", default: false },
	},
});

const org = values.org?.trim() || undefined;
if (org && !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(org)) throw new Error(`--org is not a GitHub organization name: ${org}`);
const name = values.name?.trim() || `software-factory-${randomBytes(3).toString("hex")}`;
const port = values.port ? Number(values.port) : 0;
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--port must be a port number");

const apiUrl = githubApiUrlFrom(process.env);
const repos = Object.keys(config.repos);
const state = newState();
const action = registrationUrl(githubWebUrl(apiUrl), state, org);

const server = await startCallbackServer({
	state,
	port,
	form: (redirectUrl) => formPage(buildManifest({ name, redirectUrl }), action, repos),
	exchange: (code) => exchangeManifestCode(code, apiUrl),
});
console.log(`\nOpen ${bold(server.url)} in your browser and click ${bold("Create on GitHub")}.`);
console.log(dim(`Creating "${name}" ${org ? `in the ${org} organization` : "on your account"}. Waiting for GitHub...`));

let app: Awaited<typeof server.result>;
try {
	app = await server.result;
} catch (error) {
	console.error(`\n${errorMessage(error)}`);
	process.exit(1);
} finally {
	await server.close();
}

const webhookSecret = randomBytes(32).toString("hex");
const env = {
	GITHUB_APP_ID: String(app.id),
	GITHUB_APP_PRIVATE_KEY: Buffer.from(app.pem).toString("base64"),
	GITHUB_WEBHOOK_SECRET: webhookSecret,
};

console.log(`\n${green("✓")} Created ${bold(app.slug)} (id ${app.id})`);

console.log(`\n${bold("1. Install the App")} on every repository in factory.config.ts:`);
console.log(`   ${app.html_url}/installations/new`);
for (const repo of repos) console.log(`   - ${repo}`);

console.log(`\n${bold("2. Deploy the Blueprint")} and paste these into its form:`);
console.log(dim("   factory-workflows"));
console.log(`   GITHUB_APP_ID=${env.GITHUB_APP_ID}`);
console.log(`   GITHUB_APP_PRIVATE_KEY=${env.GITHUB_APP_PRIVATE_KEY}`);
console.log(dim("   factory-gateway"));
console.log(`   GITHUB_WEBHOOK_SECRET=${env.GITHUB_WEBHOOK_SECRET}`);
console.log(dim("   The private key is base64-encoded so it fits on one line. Keep these values secret."));

console.log(`\n${bold("3. Connect the webhook")} once the gateway is live:`);
console.log("   npm run setup:github -- --gateway-url https://<gateway>.onrender.com --webhook-secret <GITHUB_WEBHOOK_SECRET>");

if (values["write-env"]) {
	await writeEnvFile(".env", env);
	console.log(`\n${green("✓")} Wrote GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, and GITHUB_WEBHOOK_SECRET to .env`);
	console.log(dim("   setup:github and doctor read .env, so --webhook-secret can be omitted."));
} else {
	console.log(yellow("\nThe private key isn't saved anywhere else. Rerun with --write-env to also write .env."));
}
