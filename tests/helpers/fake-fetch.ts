export interface FakeRequest {
	method: string;
	url: URL;
	headers: Headers;
	body: unknown;
}

/** A JSON body, a Response, an Error to throw, or a handler producing one. */
export type Reply = object | string | number | boolean | null | undefined;
export type Handler = (request: FakeRequest, params: Record<string, string>) => Reply | Promise<Reply>;
/** Keyed `METHOD /path`, where `:name` matches one path segment. */
export type Routes = Record<string, Reply | Handler>;

export function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Routes requests by method and pathname and records them. A handler returning undefined falls through; unmatched requests get a 404. */
export function fakeFetch(routes: Routes) {
	const requests: FakeRequest[] = [];
	const table = Object.entries(routes).map(([key, reply]) => {
		const [method, path = ""] = key.split(" ");
		return { method, pattern: new RegExp(`^${path.replace(/:(\w+)/g, "(?<$1>[^/]+)")}$`), reply };
	});
	const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const request: FakeRequest = {
			method: init?.method ?? "GET",
			url: new URL(String(input)),
			headers: new Headers(init?.headers),
			body: init?.body ? JSON.parse(String(init.body)) : undefined,
		};
		requests.push(request);
		for (const { method, pattern, reply } of table) {
			const match = method === request.method ? pattern.exec(request.url.pathname) : null;
			if (!match) continue;
			const params = Object.fromEntries(Object.entries(match.groups ?? {}).map(([k, v]) => [k, decodeURIComponent(v)]));
			const value = typeof reply === "function" ? await reply(request, params) : reply;
			if (value === undefined) continue;
			if (value instanceof Error) throw value;
			return value instanceof Response ? value.clone() : json(value);
		}
		return json({ message: "Not Found" }, 404);
	}) as typeof globalThis.fetch;
	return { fetch, requests };
}
