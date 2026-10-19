/**
 * The GitHub App manifest flow: a page on 127.0.0.1 that POSTs the manifest to GitHub, and the callback that
 * exchanges GitHub's code for the App's credentials.
 * https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { REQUIRED_EVENTS, REQUIRED_PERMISSIONS } from "./requirements.js";

/** The gateway doesn't exist yet. setup:github sets the real URL; the hook stays inactive until then. */
export const PLACEHOLDER_WEBHOOK_URL = "https://example.com/software-factory-gateway-not-deployed";
const HOMEPAGE = "https://github.com/render-examples/software-factory";

export interface Manifest {
	name: string;
	url: string;
	description: string;
	hook_attributes: { url: string; active: boolean };
	redirect_url: string;
	public: boolean;
	default_permissions: Record<string, string>;
	default_events: string[];
}

export function buildManifest(opts: { name: string; redirectUrl: string }): Manifest {
	return {
		name: opts.name,
		url: HOMEPAGE,
		description: "Software Factory: labeled issue to spec to draft PR to review, on Render.",
		hook_attributes: { url: PLACEHOLDER_WEBHOOK_URL, active: false },
		redirect_url: opts.redirectUrl,
		public: false,
		default_permissions: { ...REQUIRED_PERMISSIONS },
		default_events: [...REQUIRED_EVENTS],
	};
}

/** GitHub's credentials response, trimmed to what setup uses. */
export interface ManifestConversion {
	id: number;
	slug: string;
	name: string;
	pem: string;
	html_url: string;
	owner?: { login: string; type: string } | null;
}

export function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

export function newState(): string {
	return randomBytes(32).toString("hex");
}

function stateMatches(expected: string, received: string | null): boolean {
	if (!received) return false;
	const a = Buffer.from(expected);
	const b = Buffer.from(received);
	return a.length === b.length && timingSafeEqual(a, b);
}

/** Where the manifest form posts: the user's or an organization's "new App" page, carrying `state`. */
export function registrationUrl(webUrl: string, state: string, org?: string): string {
	const path = org ? `/organizations/${encodeURIComponent(org)}/settings/apps/new` : "/settings/apps/new";
	return `${webUrl}${path}?state=${encodeURIComponent(state)}`;
}

const STYLE =
	"body{font-family:system-ui,sans-serif;max-width:36rem;margin:5rem auto;padding:0 1rem;line-height:1.5}" +
	"button{font-size:1rem;padding:.6rem 1.1rem;border-radius:6px;border:0;background:#1f6feb;color:#fff;cursor:pointer}" +
	"code{background:#f0f0f3;padding:.1rem .3rem;border-radius:4px}";

function page(title: string, body: string): string {
	return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body>${body}</body></html>`;
}

/** The form GitHub requires: the manifest arrives as a browser form POST. Every interpolated value is escaped. */
export function formPage(manifest: Manifest, action: string, repos: readonly string[]): string {
	const repoList = repos.map((r) => `<li><code>${escapeHtml(r)}</code></li>`).join("");
	return page(
		`Create ${manifest.name}`,
		`<h1>Create the ${escapeHtml(manifest.name)} GitHub App</h1>` +
			"<p>It requests Contents, Issues, and Pull requests (write) and Metadata (read), and subscribes to " +
			"issues, issue comments, pull requests, and pushes. Its webhook starts inactive; " +
			"<code>npm run setup:github</code> points it at your gateway after you deploy.</p>" +
			`<p>Install it on every repository in <code>factory.config.ts</code>:</p><ul>${repoList}</ul>` +
			`<form method="post" action="${escapeHtml(action)}">` +
			`<input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">` +
			'<button type="submit">Create on GitHub</button></form>',
	);
}

export function successPage(app: ManifestConversion): string {
	return page(
		`${app.name} created`,
		`<h1><code>${escapeHtml(app.slug)}</code> created</h1>` +
			`<p><a href="${escapeHtml(`${app.html_url}/installations/new`)}">Install it</a> on every repository in ` +
			"<code>factory.config.ts</code>, then return to your terminal.</p>",
	);
}

export interface CallbackServerOptions {
	state: string;
	/** Builds the form page once the server's port is known. */
	form: (redirectUrl: string) => string;
	exchange: (code: string) => Promise<ManifestConversion>;
	/** 0 picks a free port. */
	port?: number;
	/** GitHub's manifest code expires after an hour. */
	timeoutMs?: number;
}

export interface CallbackServer {
	/** http://127.0.0.1:<port> */
	url: string;
	redirectUrl: string;
	/** Resolves with the App's credentials after a callback with the right state exchanges successfully. */
	result: Promise<ManifestConversion>;
	close(): Promise<void>;
}

/** Serves the form and waits for GitHub's redirect. Binds 127.0.0.1 only, and rejects a callback whose state differs. */
export async function startCallbackServer(opts: CallbackServerOptions): Promise<CallbackServer> {
	let settle!: { resolve: (app: ManifestConversion) => void; reject: (error: Error) => void };
	const result = new Promise<ManifestConversion>((resolve, reject) => {
		settle = { resolve, reject };
	});
	let done = false;
	let redirectUrl = "";

	const server: Server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		const html = (status: number, body: string) => {
			res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
			res.end(body);
		};
		if (req.method !== "GET") return html(405, page("Method not allowed", "<p>Method not allowed.</p>"));
		if (url.pathname === "/") return html(200, opts.form(redirectUrl));
		if (url.pathname !== "/callback") return html(404, page("Not found", "<p>Not found.</p>"));
		if (done) return html(410, page("Already done", "<p>This setup has already finished. Return to your terminal.</p>"));
		if (!stateMatches(opts.state, url.searchParams.get("state"))) {
			return html(400, page("State mismatch", "<p>The callback's state doesn't match this setup. Start again.</p>"));
		}
		const code = url.searchParams.get("code");
		if (!code || !/^[A-Za-z0-9_-]+$/.test(code)) return html(400, page("No code", "<p>The callback has no code.</p>"));
		done = true;
		opts.exchange(code).then(
			(app) => {
				html(200, successPage(app));
				settle.resolve(app);
			},
			(error: unknown) => {
				html(502, page("Exchange failed", "<p>Exchanging GitHub's code failed. See your terminal.</p>"));
				settle.reject(error instanceof Error ? error : new Error(String(error)));
			},
		);
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(opts.port ?? 0, "127.0.0.1", () => resolve());
	});
	const { port } = server.address() as AddressInfo;
	const url = `http://127.0.0.1:${port}`;
	redirectUrl = `${url}/callback`;

	const timer = setTimeout(
		() => settle.reject(new Error("Timed out waiting for GitHub's callback")),
		opts.timeoutMs ?? 60 * 60_000,
	);
	timer.unref();
	const close = () =>
		new Promise<void>((resolve) => {
			clearTimeout(timer);
			server.closeAllConnections();
			server.close(() => resolve());
		});
	return { url, redirectUrl, result, close };
}

/** POST /app-manifests/{code}/conversions: unauthenticated; the code is the credential. */
export async function exchangeManifestCode(
	code: string,
	apiUrl: string,
	fetchImpl: typeof fetch = fetch,
): Promise<ManifestConversion> {
	const response = await fetchImpl(`${apiUrl}/app-manifests/${encodeURIComponent(code)}/conversions`, {
		method: "POST",
		headers: {
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
			"User-Agent": "software-factory-setup",
		},
		signal: AbortSignal.timeout(15_000),
	});
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`Manifest conversion failed (${response.status}): ${text.slice(0, 200)}`);
	}
	const app = (await response.json()) as Partial<ManifestConversion>;
	if (typeof app.id !== "number" || !app.slug || !app.pem || !app.html_url) {
		throw new Error("Manifest conversion returned an incomplete App");
	}
	return { id: app.id, slug: app.slug, name: app.name ?? app.slug, pem: app.pem, html_url: app.html_url, owner: app.owner };
}
