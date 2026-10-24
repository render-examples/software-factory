// The run viewer: lists task runs from /api/runs and expands a run into its events. No dependencies, no build step.
// Every value from the API is set with textContent, never parsed as HTML.

const PAGE_SIZE = 50;
/** A run with no recorded finish this long after it started is past every task's timeout (the longest is 4 hours). */
const STALE_MS = 5 * 60 * 60 * 1000;
const COLUMNS = 8;
const PAYLOAD_PREVIEW_CHARS = 160;

const tbody = document.querySelector("#runs tbody");
const older = document.getElementById("older");
const notice = document.getElementById("notice");
const timeFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });

let cursor = null;
let loading = false;

/** Resolves `path` against the origin, not the page URL: fetch refuses URLs carrying user:password@ credentials. */
async function getJson(path) {
	const response = await fetch(new URL(path, window.location.origin), { headers: { accept: "application/json" } });
	const body = await response.json().catch(() => ({}));
	if (!response.ok) throw new Error(body.error || `${response.status} ${response.statusText}`);
	return body;
}

function el(tag, text, className) {
	const node = document.createElement(tag);
	if (text !== undefined && text !== null) node.textContent = String(text);
	if (className) node.className = className;
	return node;
}

function showNotice(text) {
	notice.textContent = text;
	notice.hidden = !text;
}

function formatDuration(ms) {
	if (!Number.isFinite(ms) || ms < 0) return "";
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function stateOf(run) {
	if (run.state) return run.state;
	return Date.now() - Date.parse(run.startedAt) > STALE_MS ? "unknown" : "running";
}

/** A link to the issue or PR on GitHub when the repo and subject look like "owner/name" and "issue#12" or "pr#34". */
function subjectCell(run) {
	const td = el("td");
	const match = /^(issue|pr)#(\d+)$/.exec(run.subject ?? "");
	if (!match || !/^[\w.-]+\/[\w.-]+$/.test(run.repo ?? "")) {
		td.textContent = [run.repo, run.subject].filter(Boolean).join(" ");
		return td;
	}
	const link = el("a", `${run.repo.split("/")[1]} ${run.subject}`);
	link.title = `${run.repo} ${run.subject}`;
	link.href = `https://github.com/${run.repo}/${match[1] === "pr" ? "pull" : "issues"}/${match[2]}`;
	link.target = "_blank";
	link.rel = "noopener noreferrer";
	link.addEventListener("click", (event) => event.stopPropagation());
	td.append(link);
	return td;
}

function statusCell(state) {
	const td = el("td");
	td.append(el("span", state, `status ${state}`));
	return td;
}

function runRow(run) {
	const tr = el("tr", undefined, "run");
	const expand = el("button", timeFormat.format(new Date(run.startedAt)), "expand");
	expand.type = "button";
	expand.title = `${run.startedAt}: show this run's events`;
	expand.setAttribute("aria-expanded", "false");
	const started = el("td", undefined, "started");
	started.append(expand);
	const state = stateOf(run);
	const end = run.finishedAt ? Date.parse(run.finishedAt) : state === "running" ? Date.now() : Number.NaN;
	tr.append(
		started,
		el("td", run.task),
		subjectCell(run),
		el("td", run.actor),
		statusCell(state),
		el("td", run.outcome, "mono"),
		el("td", formatDuration(end - Date.parse(run.startedAt)), "num"),
		el("td", run.costUsd === null ? "" : `$${run.costUsd.toFixed(4)}`, "num"),
	);
	expand.addEventListener("click", (event) => {
		event.stopPropagation();
		toggleEvents(tr, expand, run);
	});
	tr.addEventListener("click", () => toggleEvents(tr, expand, run));
	return tr;
}

async function toggleEvents(tr, expand, run) {
	const next = tr.nextElementSibling;
	if (next?.classList.contains("detail")) {
		next.remove();
		tr.classList.remove("open");
		expand.setAttribute("aria-expanded", "false");
		return;
	}
	tr.classList.add("open");
	expand.setAttribute("aria-expanded", "true");
	const detail = el("tr", undefined, "detail");
	const td = el("td", "Loading events…");
	td.colSpan = COLUMNS;
	detail.append(td);
	tr.after(detail);
	try {
		const { events } = await getJson(`/api/runs/${encodeURIComponent(run.traceId)}/events`);
		td.replaceChildren(eventsTable(events));
	} catch (error) {
		td.textContent = `Could not load events: ${error.message}`;
	}
}

function eventsTable(events) {
	if (events.length === 0) return el("p", "No events recorded for this run.");
	const table = el("table", undefined, "events");
	const head = el("tr");
	for (const name of ["Elapsed", "Type", "Run", "Payload"]) head.append(el("th", name));
	const thead = el("thead");
	thead.append(head);
	const body = el("tbody");
	table.append(thead);
	const start = Date.parse(events[0].at);
	for (const event of events) {
		const row = el("tr");
		const offset = el("td", `+${formatDuration(Date.parse(event.at) - start) || "0s"}`, "num");
		offset.title = event.at;
		row.append(offset, el("td", event.type, "mono"), el("td", event.runId, "mono"), payloadCell(event.payload));
		body.append(row);
	}
	table.append(body);
	return table;
}

/** A one-line preview; the full payload opens in place. */
function payloadCell(payload) {
	const td = el("td", undefined, "payload");
	const json = JSON.stringify(payload ?? {});
	if (json.length <= PAYLOAD_PREVIEW_CHARS) {
		td.append(el("code", json));
		return td;
	}
	const details = el("details");
	details.append(el("summary", `${json.slice(0, PAYLOAD_PREVIEW_CHARS)}…`), el("pre", JSON.stringify(payload, null, 2)));
	td.append(details);
	return td;
}

async function loadRuns({ reset }) {
	if (loading) return;
	loading = true;
	try {
		const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
		if (!reset && cursor !== null) params.set("before", String(cursor));
		const { runs, next } = await getJson(`/api/runs?${params}`);
		const rows = document.createDocumentFragment();
		for (const run of runs) rows.append(runRow(run));
		if (reset) tbody.replaceChildren(rows);
		else tbody.append(rows);
		cursor = next;
		older.hidden = next === null;
		showNotice(tbody.children.length === 0 ? "No runs recorded yet." : "");
	} catch (error) {
		showNotice(error.message);
	} finally {
		loading = false;
	}
}

document.getElementById("refresh").addEventListener("click", () => loadRuns({ reset: true }));
older.addEventListener("click", () => loadRuns({ reset: false }));
loadRuns({ reset: true });
