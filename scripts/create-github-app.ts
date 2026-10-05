/**
 * Create a GitHub App for this factory using GitHub's manifest flow.
 *
 * GitHub generates the app, its private key, and its webhook secret in one
 * step, so none of that has to be assembled by hand. The flow is:
 *
 *   1. This script serves a page that POSTs a manifest to GitHub.
 *   2. You click Create, then Install.
 *   3. GitHub redirects back with a code, which is exchanged for credentials.
 *   4. The script prints the environment variables to set.
 *
 *   npm run setup:app -- --gateway-url https://my-gateway.onrender.com
 */
import { createServer } from "node:http";
import { parseArgs } from "node:util";
import { repository } from "../app/config/index.js";
import { ask, bold, dim, green, heading, yellow } from "./support.js";

const API = process.env.GITHUB_API_URL ?? "https://api.github.com";
const PORT = 8765;
const REDIRECT = `http://localhost:${PORT}/callback`;

const { values } = parseArgs({
	options: {
		"gateway-url": { type: "string" },
		name: { type: "string" },
		org: { type: "string" },
	},
	allowPositionals: true,
});

interface AppCredentials {
	id: number;
	slug: string;
	pem: string;
	webhook_secret: string;
	html_url: string;
}

const repo = repository();
const gatewayUrl = (
	values["gateway-url"]?.trim() ||
	(await ask("Gateway URL", "https://render-factory-gateway.onrender.com"))
).replace(/\/+$/, "");
const appName =
	values.name?.trim() || (await ask("App name", `render-factory-${repo.repo}`));

const manifest = {
	name: appName,
	url: `https://github.com/${repo.fullName}`,
	hook_attributes: { url: `${gatewayUrl}/webhooks/github`, active: true },
	redirect_url: REDIRECT,
	public: false,
	default_events: ["issues"],
	default_permissions: {
		metadata: "read",
		contents: "write",
		issues: "write",
		pull_requests: "write",
	},
};

/** GitHub requires the manifest to arrive as a form POST from a browser. */
function formPage(): string {
	const action = values.org
		? `https://github.com/organizations/${values.org}/settings/apps/new`
		: "https://github.com/settings/apps/new";

	return `<!doctype html>
<html><head><meta charset="utf-8"><title>Create ${appName}</title>
<style>
 body{font-family:system-ui,sans-serif;max-width:34rem;margin:6rem auto;padding:0 1rem;color:#1a1a2e}
 button{background:#4361ee;color:#fff;border:0;border-radius:6px;padding:.7rem 1.2rem;font-size:1rem;cursor:pointer}
 code{background:#f1f1f4;padding:.15rem .35rem;border-radius:4px}
</style></head>
<body>
<h1>Create ${appName}</h1>
<p>This creates a GitHub App for <code>${repo.fullName}</code> with Contents,
Issues, and Pull Requests write access, and points its webhook at
<code>${gatewayUrl}/webhooks/github</code>.</p>
<form method="post" action="${action}">
  <input type="hidden" name="manifest" value='${JSON.stringify(manifest).replace(/'/g, "&apos;")}'>
  <button type="submit">Create on GitHub</button>
</form>
</body></html>`;
}

async function exchange(code: string): Promise<AppCredentials> {
	const response = await fetch(`${API}/app-manifests/${code}/conversions`, {
		method: "POST",
		headers: {
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
			"User-Agent": "render-factory-setup",
		},
		signal: AbortSignal.timeout(15_000),
	});
	if (!response.ok) {
		throw new Error(
			`Manifest conversion failed (HTTP ${response.status}): ${(await response.text()).slice(0, 200)}`,
		);
	}
	return (await response.json()) as AppCredentials;
}

function serveUntilCallback(): Promise<AppCredentials> {
	return new Promise((resolve, reject) => {
		const server = createServer(async (req, res) => {
			const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

			if (url.pathname === "/") {
				res.writeHead(200, { "content-type": "text/html" });
				res.end(formPage());
				return;
			}

			if (url.pathname !== "/callback") {
				res.writeHead(404).end("Not found");
				return;
			}

			const code = url.searchParams.get("code");
			if (!code) {
				res.writeHead(400).end("No code in callback");
				return;
			}

			try {
				const credentials = await exchange(code);
				res.writeHead(200, { "content-type": "text/html" });
				res.end(
					`<body style="font-family:system-ui;max-width:34rem;margin:6rem auto">
					 <h1>${credentials.slug} created</h1>
					 <p>Install it on <code>${repo.fullName}</code>, then return to your terminal.</p>
					 <p><a href="${credentials.html_url}/installations/new">Install the app →</a></p>
					 </body>`,
				);
				server.close();
				resolve(credentials);
			} catch (error) {
				res.writeHead(500).end(String(error));
				server.close();
				reject(error);
			}
		});

		server.listen(PORT, () => {
			console.log(`\nOpen ${bold(`http://localhost:${PORT}`)} to continue.`);
			console.log(dim("Waiting for GitHub to redirect back..."));
		});
		server.on("error", reject);
	});
}

const credentials = await serveUntilCallback();

heading("App created");
console.log(`  ${green("✓")} ${credentials.slug} (id ${credentials.id})`);

console.log(`\n${bold("Install it, then find the installation ID:")}`);
console.log(`  ${credentials.html_url}/installations/new`);
console.log(
	dim(
		"\nAfter installing, the URL ends in /installations/<id> — that is the ID.",
	),
);

const installationId = await ask("\nInstallation ID");

heading("Set these on the Workflows service");
console.log(`
GITHUB_APP_ID=${credentials.id}
GITHUB_APP_INSTALLATION_ID=${installationId}
GITHUB_APP_PRIVATE_KEY=${Buffer.from(credentials.pem).toString("base64")}
`);
console.log(
	dim(
		"The private key is base64-encoded so it survives as a single-line variable.",
	),
);

heading("Set this on the gateway");
console.log(`\nGITHUB_WEBHOOK_SECRET=${credentials.webhook_secret}\n`);
console.log(yellow("GitHub App authentication is required — no PAT fallback."));
console.log(dim("\nVerify with: npm run doctor"));
