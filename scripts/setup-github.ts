/**
 * Step 3 of setup, after the Blueprint is deployed: point the App's webhook at the gateway and create the
 * factory's labels on every configured repository. Idempotent; prints what it changed.
 *
 *   npm run setup:github -- --gateway-url https://<gateway>.onrender.com [--webhook-secret <secret>]
 *
 * Reads GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY (and GITHUB_WEBHOOK_SECRET as the default secret) from the
 * environment or .env.
 */
import { parseArgs } from "node:util";
import { config } from "../app/config/index.js";
import { GitHubApp } from "./lib/github.js";
import { errorMessage, Reporter } from "./lib/output.js";
import { setupGithub } from "./lib/setup-github.js";

const { values } = parseArgs({
	options: {
		"gateway-url": { type: "string" },
		"webhook-secret": { type: "string" },
	},
});

const gatewayUrl = values["gateway-url"]?.trim();
const webhookSecret = values["webhook-secret"]?.trim() || process.env.GITHUB_WEBHOOK_SECRET?.trim();
if (!gatewayUrl || !webhookSecret) {
	console.error(
		"Usage: npm run setup:github -- --gateway-url https://<gateway>.onrender.com --webhook-secret <secret>\n" +
			"The secret must equal the gateway's GITHUB_WEBHOOK_SECRET; it defaults to GITHUB_WEBHOOK_SECRET in .env.",
	);
	process.exit(2);
}

const out = new Reporter();
try {
	const app = new GitHubApp({ env: process.env });
	process.exitCode = await setupGithub(app, { gatewayUrl, webhookSecret, repos: Object.keys(config.repos) }, out);
} catch (error) {
	out.fail(errorMessage(error));
	process.exitCode = 1;
}
