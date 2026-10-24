import { readFileSync } from "node:fs";
import type { Context, Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import type { RunSummary, TraceEvent } from "../../events/index.js";

export interface ViewerDeps {
	/** HTTP Basic auth password for the user `factory`. */
	password: string;
	listRuns(opts: { before?: number; limit: number }): Promise<RunSummary[] | null>;
	listTraceEvents(traceId: string): Promise<TraceEvent[] | null>;
}

/** The viewer stays off unless its password is at least this long; render.yaml generates one. */
export const MIN_VIEWER_PASSWORD_CHARS = 16;

const asset = (name: string) => readFileSync(new URL(name, import.meta.url), "utf8");
const PAGE = asset("./page.html");
const SCRIPT = asset("./app.js");
const STYLE = asset("./app.css");

/** Telemetry includes repository names, issue subjects, and error snippets: never cache it, frame it, or leak it. */
const HEADERS: Record<string, string> = {
	"cache-control": "no-store",
	"content-security-policy":
		"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
	"referrer-policy": "no-referrer",
	"x-content-type-options": "nosniff",
};
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const TRACE_ID = /^[\w.-]{1,128}$/;
const TELEMETRY_OFF = { error: "telemetry is off: set DATABASE_URL on the gateway" };

/** The run viewer: a page at /runs and its JSON API under /api/runs, behind HTTP Basic auth. */
export function mountViewer(app: Hono, deps: ViewerDeps): void {
	const auth = basicAuth({ username: "factory", password: deps.password, realm: "software-factory" });
	for (const path of ["/runs", "/runs/*", "/api/runs", "/api/runs/*"]) {
		app.use(path, auth, async (c, next) => {
			await next();
			for (const [name, value] of Object.entries(HEADERS)) c.header(name, value);
		});
	}

	app.get("/runs", (c) => c.html(PAGE));
	app.get("/runs/app.js", (c) => c.body(SCRIPT, 200, { "content-type": "text/javascript; charset=utf-8" }));
	app.get("/runs/app.css", (c) => c.body(STYLE, 200, { "content-type": "text/css; charset=utf-8" }));

	app.get("/api/runs", async (c) => {
		const { limit: rawLimit, before } = c.req.query();
		const limit = rawLimit === undefined ? DEFAULT_LIMIT : positiveInt(rawLimit);
		const cursor = before === undefined ? undefined : positiveInt(before);
		if (limit === null || limit > MAX_LIMIT || cursor === null) {
			return c.json({ error: `limit must be 1-${MAX_LIMIT} and before a positive integer` }, 400);
		}
		return read(
			c,
			() => deps.listRuns({ before: cursor, limit }),
			(runs) => ({ runs, next: runs.length === limit ? (runs.at(-1)?.id ?? null) : null }),
		);
	});

	app.get("/api/runs/:traceId/events", async (c) => {
		const traceId = c.req.param("traceId");
		if (!TRACE_ID.test(traceId)) return c.json({ error: "invalid trace id" }, 400);
		return read(
			c,
			() => deps.listTraceEvents(traceId),
			(events) => ({ events }),
		);
	});
}

async function read<T>(c: Context, query: () => Promise<T | null>, shape: (rows: T) => object): Promise<Response> {
	try {
		const rows = await query();
		return rows === null ? c.json(TELEMETRY_OFF, 503) : c.json(shape(rows));
	} catch (error) {
		console.error(JSON.stringify({ level: "warn", msg: "viewer query failed", error: error instanceof Error ? error.message : String(error) }));
		return c.json({ error: "could not read telemetry" }, 502);
	}
}

function positiveInt(value: string | undefined): number | null {
	if (value === undefined || !/^\d{1,15}$/.test(value)) return null;
	const n = Number(value);
	return n > 0 ? n : null;
}
