import { Hono } from "hono";
import {
	getRun,
	getSpec,
	listArtifactsByRun,
	listConversation,
	listDeliveries,
	listEventsByRun,
	listRuns,
	listSpecVersions,
} from "../../store/index.js";
import type { ArtifactRecord, RunRecord } from "../../store/index.js";
import {
	constantTimeEqual,
	parseCookies,
	sessionClearCookie,
	sessionCookieName,
	sessionSetCookie,
	signSession,
	verifySession,
} from "../auth.js";
import { Layout } from "./layout.js";
import { buildSpanTree, type SpanNode } from "./spans.js";

function requireSession(c: {
	req: { header: (n: string) => string | undefined };
	redirect: (url: string) => Response;
}): boolean {
	const adminToken = process.env.FACTORY_ADMIN_TOKEN?.trim();
	if (!adminToken) return false;
	const cookies = parseCookies(c.req.header("cookie") ?? null);
	const session = cookies[sessionCookieName()];
	if (!session) return false;
	return verifySession(session, adminToken);
}

function ago(iso: string): string {
	const ms = Date.now() - new Date(iso).getTime();
	if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
	if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
	if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
	return `${Math.floor(ms / 86_400_000)}d ago`;
}

function statusBadge(status: string) {
	return <span class={`badge badge-${status}`}>{status}</span>;
}

function formatCost(usd: number): string {
	return `$${usd.toFixed(4)}`;
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	return `${(ms / 60_000).toFixed(1)}m`;
}

function SpanTreeView(props: { nodes: SpanNode[] }) {
	if (props.nodes.length === 0) return null;
	return (
		<div class="span-tree">
			{props.nodes.map((node) => (
				<div class="span-item" key={node.spanId}>
					{node.phase === "point" ? (
						<span class="span-point">● {node.type}</span>
					) : (
						<span class="span-label">
							{node.type}
							{node.stage ? ` (${node.stage})` : ""}
						</span>
					)}
					{node.durationMs !== null && (
						<span class="span-dur">{formatDuration(node.durationMs)}</span>
					)}
					{node.children.length > 0 && <SpanTreeView nodes={node.children} />}
				</div>
			))}
		</div>
	);
}

function RunRow(props: { run: RunRecord }) {
	const r = props.run;
	return (
		<tr>
			<td>
				<a href={`/ui/runs/${r.id}`} class="mono">
					{r.id.slice(0, 8)}
				</a>
			</td>
			<td>{statusBadge(r.status)}</td>
			<td>{r.workflow}</td>
			<td>
				{r.subjectKind === "pull_request" ? "PR" : "Issue"} #{r.subjectNumber}
			</td>
			<td>{r.stage ?? "—"}</td>
			<td class="meta">{ago(r.createdAt)}</td>
			<td class="cost">{formatCost(r.costUsd)}</td>
		</tr>
	);
}

export function uiRoutes(): Hono {
	const app = new Hono();

	app.get("/ui/login", (c) => {
		const error = c.req.query("error");
		return c.html(
			<html lang="en">
				<head>
					<meta charset="utf-8" />
					<title>Login — render-factory</title>
					<style>{`
						* { margin:0; padding:0; box-sizing:border-box; }
						body { font-family:system-ui,sans-serif; background:#f8f9fa; }
						.login-box { max-width:360px; margin:4rem auto; background:#fff; padding:2rem; border-radius:8px; box-shadow:0 1px 3px rgba(0,0,0,0.1); }
						h1 { font-size:1.25rem; margin-bottom:1rem; }
						input[type=password], button { display:block; width:100%; padding:0.5rem; margin-bottom:0.75rem; border:1px solid #d1d5db; border-radius:4px; font-size:1rem; }
						button { background:#0066cc; color:#fff; border:none; cursor:pointer; }
						.error-msg { color:#dc2626; font-size:0.875rem; margin-bottom:0.5rem; }
					`}</style>
				</head>
				<body>
					<div class="login-box">
						<h1>render-factory</h1>
						{error && <p class="error-msg">Invalid token. Please try again.</p>}
						<form method="post" action="/ui/login">
							<input
								type="password"
								name="token"
								placeholder="Admin token"
								autocomplete="current-password"
								required
							/>
							<button type="submit">Login</button>
						</form>
					</div>
				</body>
			</html>,
		);
	});

	app.post("/ui/login", async (c) => {
		const adminToken = process.env.FACTORY_ADMIN_TOKEN?.trim();
		if (!adminToken) return c.redirect("/ui/login?error=1");

		const form = await c.req.parseBody();
		const token = typeof form.token === "string" ? form.token : "";

		if (!constantTimeEqual(token, adminToken)) {
			return c.redirect("/ui/login?error=1");
		}

		const sessionValue = signSession(adminToken);
		return new Response(null, {
			status: 302,
			headers: {
				Location: "/ui",
				"Set-Cookie": sessionSetCookie(sessionValue),
			},
		});
	});

	app.post("/ui/logout", (_c) => {
		return new Response(null, {
			status: 302,
			headers: {
				Location: "/ui/login",
				"Set-Cookie": sessionClearCookie(),
			},
		});
	});

	app.use("/ui", async (c, next) => {
		if (!requireSession(c)) return c.redirect("/ui/login");
		await next();
	});

	app.use("/ui/*", async (c, next) => {
		const path = c.req.path;
		if (path === "/ui/login" || path === "/ui/logout") {
			await next();
			return;
		}
		if (!requireSession(c)) return c.redirect("/ui/login");
		await next();
	});

	app.get("/ui", async (c) => {
		const q = c.req.query();
		const runs = await listRuns({
			workflow: q.workflow || undefined,
			status: q.status as RunRecord["status"] | undefined,
			subjectKind: q.subjectKind as RunRecord["subjectKind"] | undefined,
			subjectNumber: q.subjectNumber ? Number(q.subjectNumber) : undefined,
			before: q.before || undefined,
			limit: 50,
		});

		return c.html(
			<Layout title="Runs">
				<h1>Runs</h1>
				<form class="filter" method="get" action="/ui">
					<select name="workflow">
						<option value="">All workflows</option>
						<option value="triage" selected={q.workflow === "triage"}>
							triage
						</option>
						<option value="spec-to-pr" selected={q.workflow === "spec-to-pr"}>
							spec-to-pr
						</option>
						<option value="pr-review" selected={q.workflow === "pr-review"}>
							pr-review
						</option>
					</select>
					<select name="status">
						<option value="">All statuses</option>
						{(
							[
								"queued",
								"dispatched",
								"running",
								"completed",
								"failed",
								"cancelled",
							] as const
						).map((s) => (
							<option value={s} selected={q.status === s}>
								{s}
							</option>
						))}
					</select>
					<button type="submit">Filter</button>
				</form>
				{runs.length === 0 ? (
					<p class="empty">No runs found.</p>
				) : (
					<table>
						<thead>
							<tr>
								<th>ID</th>
								<th>Status</th>
								<th>Workflow</th>
								<th>Subject</th>
								<th>Stage</th>
								<th>Age</th>
								<th>Cost</th>
							</tr>
						</thead>
						<tbody>
							{runs.map((r) => (
								<RunRow run={r} key={r.id} />
							))}
						</tbody>
					</table>
				)}
			</Layout>,
		);
	});

	app.get("/ui/runs/:id", async (c) => {
		const id = c.req.param("id");
		const run = await getRun(id);
		if (!run)
			return c.html(
				<Layout title="Not Found">
					<h1>Run not found</h1>
				</Layout>,
				404,
			);

		const [events, conversation, artifacts] = await Promise.all([
			listEventsByRun(id),
			listConversation(id),
			listArtifactsByRun(id),
		]);

		const spanTree = buildSpanTree(events);

		const costEvents = events.filter((e) => e.type === "agent.cost");
		const costByAgent: Record<string, number> = {};
		for (const ce of costEvents) {
			const agent = (ce.payload?.agent as string) ?? "unknown";
			const cost = (ce.payload?.costUsd as number) ?? 0;
			costByAgent[agent] = (costByAgent[agent] ?? 0) + cost;
		}

		let spec = null;
		let specVersions: Awaited<ReturnType<typeof listSpecVersions>> = [];
		const specId = (run.input as Record<string, unknown>)?.specId as
			| string
			| undefined;
		if (specId) {
			spec = await getSpec(specId);
			if (spec) {
				specVersions = await listSpecVersions(specId);
			}
		}

		const repo = run.repo;
		const resultObj = run.result as Record<string, unknown> | null;
		const prUrl = resultObj?.pullRequest as string | undefined;
		const issueUrl = repo
			? `https://github.com/${repo}/issues/${run.subjectNumber}`
			: null;

		const screenshots = artifacts.filter((a: ArtifactRecord) =>
			a.contentType.startsWith("image/"),
		);
		const transcripts = artifacts.filter(
			(a: ArtifactRecord) => a.kind === "transcript",
		);
		const otherArtifacts = artifacts.filter(
			(a: ArtifactRecord) =>
				!a.contentType.startsWith("image/") && a.kind !== "transcript",
		);

		return c.html(
			<Layout title={`Run ${id.slice(0, 8)}`}>
				<h1>Run {id.slice(0, 8)}…</h1>
				<div class="card">
					<p>
						<strong>Status:</strong> {statusBadge(run.status)}
						{run.outcome && (
							<>
								{" "}
								— <strong>Outcome:</strong> {run.outcome}
							</>
						)}
					</p>
					<p>
						<strong>Workflow:</strong> {run.workflow}
					</p>
					<p>
						<strong>Subject:</strong>{" "}
						{run.subjectKind === "pull_request" ? "PR" : "Issue"} #
						{run.subjectNumber}
						{issueUrl && (
							<>
								{" "}
								(
								<a href={issueUrl} target="_blank" rel="noopener">
									GitHub
								</a>
								)
							</>
						)}
					</p>
					{run.stage && (
						<p>
							<strong>Stage:</strong> {run.stage}
						</p>
					)}
					<p>
						<strong>Cost:</strong>{" "}
						<span class="cost">{formatCost(run.costUsd)}</span>
					</p>
					{run.summary && (
						<p>
							<strong>Summary:</strong> {run.summary}
						</p>
					)}
					<p class="meta">
						Created {run.createdAt}
						{run.startedAt && <> · Started {run.startedAt}</>}
						{run.completedAt && <> · Completed {run.completedAt}</>}
					</p>
					{prUrl && (
						<p>
							<a href={prUrl} target="_blank" rel="noopener">
								View Pull Request
							</a>
						</p>
					)}
				</div>

				{conversation.length > 1 && (
					<div class="card">
						<h2>Conversation</h2>
						<div class="conversation">
							{conversation.map((r) => (
								<a
									href={`/ui/runs/${r.id}`}
									class={r.id === id ? "current" : ""}
									key={r.id}
								>
									{r.workflow} — {r.outcome ?? r.status}
								</a>
							))}
						</div>
					</div>
				)}

				{Object.keys(costByAgent).length > 0 && (
					<div class="card">
						<h2>Cost by Agent</h2>
						<table>
							<thead>
								<tr>
									<th>Agent</th>
									<th>Cost</th>
								</tr>
							</thead>
							<tbody>
								{Object.entries(costByAgent).map(([agent, cost]) => (
									<tr key={agent}>
										<td>{agent}</td>
										<td class="cost">{formatCost(cost)}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}

				{spec && specVersions.length > 0 && (
					<div class="card">
						<h2>Spec Versions</h2>
						<table>
							<thead>
								<tr>
									<th>Version</th>
									<th>Created</th>
								</tr>
							</thead>
							<tbody>
								{specVersions.map((v) => (
									<tr key={v.version}>
										<td>v{v.version}</td>
										<td class="meta">{v.createdAt}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}

				<div class="card">
					<h2>Timeline</h2>
					{spanTree.length === 0 ? (
						<p class="empty">No spans recorded.</p>
					) : (
						<SpanTreeView nodes={spanTree} />
					)}
				</div>

				{screenshots.length > 0 && (
					<div class="card">
						<h2>Screenshots</h2>
						{screenshots.map((a: ArtifactRecord) => (
							<div key={a.id}>
								<img
									src={`/ui/artifacts/${a.id}`}
									alt={`${a.kind} artifact`}
									class="screenshot"
									loading="lazy"
								/>
								<p class="meta">
									{a.kind} · {a.size} bytes · {ago(a.createdAt)}
								</p>
							</div>
						))}
					</div>
				)}

				{transcripts.length > 0 && (
					<div class="card">
						<h2>Transcripts</h2>
						{transcripts.map((a: ArtifactRecord) => (
							<div key={a.id}>
								<p class="meta">
									{a.kind} · {a.size} bytes
								</p>
								<p>
									<a href={`/ui/artifacts/${a.id}`}>Download transcript</a>
								</p>
							</div>
						))}
					</div>
				)}

				{otherArtifacts.length > 0 && (
					<div class="card">
						<h2>Artifacts</h2>
						<table>
							<thead>
								<tr>
									<th>Kind</th>
									<th>Type</th>
									<th>Size</th>
									<th>Created</th>
									<th></th>
								</tr>
							</thead>
							<tbody>
								{otherArtifacts.map((a: ArtifactRecord) => (
									<tr key={a.id}>
										<td>{a.kind}</td>
										<td class="mono">{a.contentType}</td>
										<td>{a.size} B</td>
										<td class="meta">{ago(a.createdAt)}</td>
										<td>
											<a href={`/ui/artifacts/${a.id}`}>Download</a>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</Layout>,
		);
	});

	app.get("/ui/deliveries", async (c) => {
		const deliveries = await listDeliveries(100);
		return c.html(
			<Layout title="Deliveries">
				<h1>Deliveries</h1>
				{deliveries.length === 0 ? (
					<p class="empty">No deliveries recorded.</p>
				) : (
					<table>
						<thead>
							<tr>
								<th>Delivery ID</th>
								<th>Event</th>
								<th>Action</th>
								<th>Outcome</th>
								<th>Received</th>
							</tr>
						</thead>
						<tbody>
							{deliveries.map((d) => (
								<tr key={d.deliveryId}>
									<td class="mono">{d.deliveryId.slice(0, 12)}</td>
									<td>{d.event}</td>
									<td>{d.action}</td>
									<td>{statusBadge(d.outcome)}</td>
									<td class="meta">{ago(d.receivedAt)}</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
			</Layout>,
		);
	});

	return app;
}
