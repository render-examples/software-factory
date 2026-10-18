import { type Context, Hono } from "hono";
import { z } from "zod";
import {
	bearerToken,
	constantTimeEqual,
	isHttps,
	parseCookies,
	SESSION_COOKIE,
	safeNext,
	sessionClearCookie,
	sessionSetCookie,
	signSession,
	verifySession,
} from "../auth.js";
import { Layout, LoginPage } from "./layout.js";
import {
	ago,
	buildTrace,
	type EventsReader,
	formatCost,
	formatDuration,
	formatTime,
	formatTokens,
	SUMMARY_TYPES,
	str,
	type TimelineItem,
	type TraceListItem,
	summarizeTraces,
	subjectUrl,
} from "./model.js";

export type { EventsReader } from "./model.js";

const DISABLED = "The trace UI is disabled: FACTORY_ADMIN_TOKEN is not set on the gateway.";
const UNAVAILABLE = "The events database is unavailable.";
const MAX_LOGIN_BODY = 16 * 1024;

const Repo = z
	.string()
	.max(200)
	.regex(/^[\w.-]+\/[\w.-]+$/, "repo must be owner/name");
const Before = z.iso.datetime({ offset: true }).transform((value) => new Date(value));
const TracesQuery = z.object({
	repo: Repo.optional(),
	limit: z.coerce.number().int().min(1).max(200).default(50),
	before: Before.optional(),
});
const DeliveriesQuery = z.object({
	repo: Repo.optional(),
	limit: z.coerce.number().int().min(1).max(500).default(100),
	before: Before.optional(),
});
const TraceId = z.string().regex(/^[A-Za-z0-9._:-]{1,200}$/, "invalid trace id");

/** Parses the query string, treating empty values (an empty filter box) as absent. */
function parseQuery<T extends z.ZodType>(c: Context, schema: T): z.ZodSafeParseResult<z.output<T>> {
	const query = Object.fromEntries(Object.entries(c.req.query()).filter(([, value]) => value !== ""));
	return schema.safeParse(query);
}

function issues(error: z.ZodError): string {
	return error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
}

function warn(msg: string, error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	console.error(JSON.stringify({ level: "warn", msg, error: message }));
}

function isUiPath(path: string): boolean {
	return path === "/ui" || path.startsWith("/ui/");
}

function isApiPath(path: string): boolean {
	return path === "/api" || path.startsWith("/api/");
}

function Badge(props: { value?: string }) {
	if (!props.value) return <span class="meta">—</span>;
	return <span class={`badge badge-${props.value.toLowerCase().replace(/[^a-z-]/g, "")}`}>{props.value}</span>;
}

function Subject(props: { repo?: string | null; subject?: string | null }) {
	if (!props.subject) return <span class="meta">—</span>;
	const url = subjectUrl(props.repo, props.subject);
	return url ? (
		<a href={url} target="_blank" rel="noopener noreferrer">
			{props.subject}
		</a>
	) : (
		<span>{props.subject}</span>
	);
}

function When(props: { at?: Date }) {
	if (!props.at) return <span class="meta">—</span>;
	return (
		<span class="meta" title={props.at.toISOString()}>
			{ago(props.at)}
		</span>
	);
}

function traceHref(traceId: string): string {
	return `/ui/traces/${encodeURIComponent(traceId)}`;
}

function pageHref(path: string, params: Record<string, string | undefined>): string {
	const search = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) if (value) search.set(key, value);
	const qs = search.toString();
	return qs ? `${path}?${qs}` : path;
}

function ErrorPage(props: { title: string; message: string }) {
	return (
		<Layout title={props.title}>
			<h1>{props.title}</h1>
			<p class="card">{props.message}</p>
		</Layout>
	);
}

function TraceRow(props: { trace: TraceListItem }) {
	const t = props.trace;
	return (
		<tr>
			<td>
				<a href={traceHref(t.traceId)} class="mono">
					{t.traceId.length > 16 ? `${t.traceId.slice(0, 16)}…` : t.traceId}
				</a>
			</td>
			<td>{t.repo ?? <span class="meta">—</span>}</td>
			<td>
				<Subject repo={t.repo} subject={t.subject} />
			</td>
			<td>{t.phase ?? <span class="meta">—</span>}</td>
			<td>
				<Badge value={t.state} />
				{t.outcome && <div class="detail">{t.outcome}</div>}
			</td>
			<td class="cost">{formatCost(t.costUsd)}</td>
			<td>{formatDuration(t.durationMs)}</td>
			<td>
				<When at={t.startedAt} />
			</td>
			<td>
				<When at={t.lastAt} />
			</td>
		</tr>
	);
}

function TimelineRow(props: { item: TimelineItem; start?: Date }) {
	const { item } = props;
	const offset = props.start ? formatDuration(item.at.getTime() - props.start.getTime()) : "";
	const time = (
		<td>
			<span class="mono" title={item.at.toISOString()}>
				{formatTime(item.at)}
			</span>
			<div class="meta">+{offset}</div>
		</td>
	);
	switch (item.kind) {
		case "delivery":
			return (
				<tr>
					{time}
					<td>delivery</td>
					<td>
						{item.event ?? "?"}
						{item.action ? `.${item.action}` : ""} <Badge value={item.outcome} />
						{item.task && <span class="meta"> → {item.task}</span>}
						{item.reason && <div class="detail">{item.reason}</div>}
						{item.deliveryId && <div class="meta mono">delivery {item.deliveryId}</div>}
					</td>
				</tr>
			);
		case "run.started":
			return (
				<tr>
					{time}
					<td>run started</td>
					<td>
						{item.phase ?? "?"}
						{item.actor && <span class="meta"> by @{item.actor}</span>}
						{item.runId && <div class="meta mono">run {item.runId}</div>}
					</td>
				</tr>
			);
		case "run.finished":
			return (
				<tr>
					{time}
					<td>run finished</td>
					<td>
						{item.phase ?? "?"} <Badge value={item.state} /> {item.outcome}
						<div class="meta">
							cost <span class="cost">{formatCost(item.costUsd)}</span> · duration {formatDuration(item.durationMs)}
						</div>
						{item.error && <div class="detail">{item.error}</div>}
					</td>
				</tr>
			);
		case "agent":
			return (
				<tr>
					{time}
					<td>agent</td>
					<td>
						<strong>{item.agentId ?? "?"}</strong> <span class="mono">{item.model}</span>{" "}
						<Badge value={item.outcome ?? "running"} />
						{item.where && <span class="meta"> in {item.where}</span>}
						<div class="meta">
							turns {item.turns ?? "—"} · tokens {formatTokens(item.tokens)} · cost{" "}
							<span class="cost">{formatCost(item.costUsd)}</span> · duration {formatDuration(item.durationMs)}
						</div>
						{item.message && <div class="detail">{item.message}</div>}
					</td>
				</tr>
			);
		default:
			return (
				<tr>
					{time}
					<td>{item.type}</td>
					<td class="meta">{item.runId && <span class="mono">run {item.runId}</span>}</td>
				</tr>
			);
	}
}

/** The trace UI (/ui) and its JSON API (/api), both behind FACTORY_ADMIN_TOKEN. They read events only. */
export function uiRoutes(opts: { adminToken?: string; events: EventsReader }): Hono {
	const { adminToken, events } = opts;
	const app = new Hono();

	app.use("*", async (c, next) => {
		const path = c.req.path;
		const ui = isUiPath(path);
		const api = isApiPath(path);
		if (!ui && !api) return next();

		c.header("Cache-Control", "no-store");
		c.header("X-Frame-Options", "DENY");
		c.header("X-Content-Type-Options", "nosniff");
		c.header("Referrer-Policy", "same-origin");
		c.header(
			"Content-Security-Policy",
			"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
		);

		if (!adminToken) return api ? c.json({ error: DISABLED }, 503) : c.text(DISABLED, 503);
		if (path === "/ui/login" || path === "/ui/logout") return next();

		if (verifySession(parseCookies(c.req.header("cookie"))[SESSION_COOKIE], adminToken)) return next();
		if (api) {
			const token = bearerToken(c.req.header("authorization"));
			if (token && constantTimeEqual(token, adminToken)) return next();
			c.header("WWW-Authenticate", 'Bearer realm="software-factory"');
			return c.json({ error: "unauthorized" }, 401);
		}
		const url = new URL(c.req.url);
		return c.redirect(`/ui/login?next=${encodeURIComponent(safeNext(`${url.pathname}${url.search}`))}`, 302);
	});

	app.get("/ui/login", (c) => c.html(<LoginPage next={safeNext(c.req.query("next"))} />));

	app.post("/ui/login", async (c) => {
		const length = Number(c.req.header("content-length") ?? 0);
		if (length > MAX_LOGIN_BODY) return c.text("payload too large", 413);
		const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
		const token = typeof form.token === "string" ? form.token : "";
		const next = safeNext(form.next);
		if (!adminToken || !token || token.length > 1024 || !constantTimeEqual(token, adminToken)) {
			return c.html(<LoginPage next={next} error />, 401);
		}
		c.header("Set-Cookie", sessionSetCookie(signSession(adminToken), isHttps(c.req.raw)));
		return c.redirect(next, 303);
	});

	const logout = (c: Context) => {
		c.header("Set-Cookie", sessionClearCookie(isHttps(c.req.raw)));
		return c.redirect("/ui/login", 303);
	};
	app.post("/ui/logout", logout);
	app.get("/ui/logout", logout);

	/** Runs a read; a database failure becomes a 503 instead of a 500. */
	async function read<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
		try {
			return { ok: true, value: await fn() };
		} catch (error) {
			warn("trace ui read failed", error);
			return { ok: false };
		}
	}

	async function loadTraces(query: z.output<typeof TracesQuery>) {
		const traces = await events.listTraces({ repo: query.repo, limit: query.limit, before: query.before });
		if (traces.length === 0) return [];
		const summary = await events.recentEvents({
			types: SUMMARY_TYPES,
			traceIds: traces.map((t) => t.traceId),
			limit: 2000,
		});
		return summarizeTraces(traces, summary);
	}

	app.get("/ui", async (c) => {
		const query = parseQuery(c, TracesQuery);
		if (!query.success) return c.html(<ErrorPage title="Bad request" message={issues(query.error)} />, 400);
		const result = await read(() => loadTraces(query.data));
		if (!result.ok) return c.html(<ErrorPage title="Unavailable" message={UNAVAILABLE} />, 503);
		const traces = result.value;
		const { repo, limit, before } = query.data;
		const last = traces.at(-1);
		return c.html(
			<Layout title="Traces">
				<h1>Traces</h1>
				<form class="filter" method="get" action="/ui">
					<input type="text" name="repo" placeholder="owner/name" value={repo ?? ""} />
					<button type="submit">Filter</button>
					{(repo || before) && <a href="/ui">Clear</a>}
				</form>
				{traces.length === 0 ? (
					<p class="empty">No traces found.</p>
				) : (
					<table>
						<thead>
							<tr>
								<th>Trace</th>
								<th>Repo</th>
								<th>Subject</th>
								<th>Phase</th>
								<th>State</th>
								<th>Cost</th>
								<th>Duration</th>
								<th>Started</th>
								<th>Last activity</th>
							</tr>
						</thead>
						<tbody>
							{traces.map((trace) => (
								<TraceRow trace={trace} />
							))}
						</tbody>
					</table>
				)}
				<div class="pager">
					{before && <a href={pageHref("/ui", { repo })}>« Newest</a>}{" "}
					{last && traces.length >= limit && (
						<a href={pageHref("/ui", { repo, before: last.lastAt.toISOString(), limit: limit === 50 ? undefined : String(limit) })}>
							Older »
						</a>
					)}
				</div>
			</Layout>,
		);
	});

	app.get("/ui/traces/:traceId", async (c) => {
		const traceId = TraceId.safeParse(c.req.param("traceId"));
		if (!traceId.success) return c.html(<ErrorPage title="Bad request" message={issues(traceId.error)} />, 400);
		const result = await read(() => events.traceEvents(traceId.data));
		if (!result.ok) return c.html(<ErrorPage title="Unavailable" message={UNAVAILABLE} />, 503);
		if (result.value.length === 0) {
			return c.html(<ErrorPage title="Trace not found" message={`No events for trace ${traceId.data}.`} />, 404);
		}
		const trace = buildTrace(traceId.data, result.value);
		const { totals } = trace;
		return c.html(
			<Layout title={`Trace ${traceId.data}`}>
				<h1 class="mono">{traceId.data}</h1>
				<div class="card">
					<p>
						{trace.repo ?? "—"} · <Subject repo={trace.repo} subject={trace.subject} />
					</p>
					<p class="meta">
						{formatTime(trace.firstAt)} → {formatTime(trace.lastAt)} · {result.value.length} events
					</p>
				</div>
				<div class="card totals">
					<div>
						<span class="meta">Cost</span>
						<strong class="cost">{formatCost(totals.costUsd)}</strong>
					</div>
					<div>
						<span class="meta">Duration{totals.durationFromRun ? "" : " (elapsed)"}</span>
						<strong>{formatDuration(totals.durationMs)}</strong>
					</div>
					<div>
						<span class="meta">Agent calls</span>
						<strong>{totals.agentCalls}</strong>
					</div>
					<div>
						<span class="meta">Agent cost</span>
						<strong class="cost">{formatCost(totals.agentCostUsd)}</strong>
					</div>
					<div>
						<span class="meta">Tokens</span>
						<strong>{formatTokens(totals.tokens)}</strong>
					</div>
				</div>
				<h2>Timeline</h2>
				<table>
					<thead>
						<tr>
							<th>Time</th>
							<th>Event</th>
							<th>Details</th>
						</tr>
					</thead>
					<tbody>
						{trace.items.map((item) => (
							<TimelineRow item={item} start={trace.firstAt} />
						))}
					</tbody>
				</table>
			</Layout>,
		);
	});

	app.get("/ui/deliveries", async (c) => {
		const query = parseQuery(c, DeliveriesQuery);
		if (!query.success) return c.html(<ErrorPage title="Bad request" message={issues(query.error)} />, 400);
		const { repo, limit, before } = query.data;
		const result = await read(() => events.recentEvents({ types: ["delivery.received"], repo, limit, before }));
		if (!result.ok) return c.html(<ErrorPage title="Unavailable" message={UNAVAILABLE} />, 503);
		const deliveries = result.value;
		const last = deliveries.at(-1);
		return c.html(
			<Layout title="Deliveries">
				<h1>Deliveries</h1>
				<form class="filter" method="get" action="/ui/deliveries">
					<input type="text" name="repo" placeholder="owner/name" value={repo ?? ""} />
					<button type="submit">Filter</button>
					{(repo || before) && <a href="/ui/deliveries">Clear</a>}
				</form>
				{deliveries.length === 0 ? (
					<p class="empty">No deliveries recorded.</p>
				) : (
					<table>
						<thead>
							<tr>
								<th>Received</th>
								<th>Event</th>
								<th>Repo</th>
								<th>Subject</th>
								<th>Outcome</th>
								<th>Task</th>
								<th>Trace</th>
							</tr>
						</thead>
						<tbody>
							{deliveries.map((d) => {
								const event = str(d.payload, "event");
								const action = str(d.payload, "action");
								const reason = str(d.payload, "reason");
								return (
									<tr>
										<td>
											<When at={d.createdAt} />
										</td>
										<td>
											{event ?? "?"}
											{action ? `.${action}` : ""}
										</td>
										<td>{d.repo ?? <span class="meta">—</span>}</td>
										<td>
											<Subject repo={d.repo} subject={d.subject} />
										</td>
										<td>
											<Badge value={str(d.payload, "outcome")} />
											{reason && <div class="detail">{reason}</div>}
										</td>
										<td>{str(d.payload, "task") ?? <span class="meta">—</span>}</td>
										<td>
											<a href={traceHref(d.traceId)} class="mono">
												{d.traceId.length > 16 ? `${d.traceId.slice(0, 16)}…` : d.traceId}
											</a>
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				)}
				<div class="pager">
					{before && <a href={pageHref("/ui/deliveries", { repo })}>« Newest</a>}{" "}
					{last && deliveries.length >= limit && (
						<a
							href={pageHref("/ui/deliveries", {
								repo,
								before: last.createdAt.toISOString(),
								limit: limit === 100 ? undefined : String(limit),
							})}
						>
							Older »
						</a>
					)}
				</div>
			</Layout>,
		);
	});

	app.get("/api/traces", async (c) => {
		const query = parseQuery(c, TracesQuery);
		if (!query.success) return c.json({ error: "invalid query", detail: issues(query.error) }, 400);
		const result = await read(() => loadTraces(query.data));
		if (!result.ok) return c.json({ error: UNAVAILABLE }, 503);
		const traces = result.value;
		const last = traces.at(-1);
		return c.json({
			traces,
			nextBefore: last && traces.length >= query.data.limit ? last.lastAt.toISOString() : null,
		});
	});

	app.get("/api/traces/:traceId", async (c) => {
		const traceId = TraceId.safeParse(c.req.param("traceId"));
		if (!traceId.success) return c.json({ error: "invalid trace id" }, 400);
		const result = await read(() => events.traceEvents(traceId.data));
		if (!result.ok) return c.json({ error: UNAVAILABLE }, 503);
		if (result.value.length === 0) return c.json({ error: "trace not found" }, 404);
		const { totals } = buildTrace(traceId.data, result.value);
		return c.json({ traceId: traceId.data, totals, events: result.value });
	});

	app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

	return app;
}
