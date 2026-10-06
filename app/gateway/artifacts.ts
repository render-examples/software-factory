import { Hono } from "hono";
import { getArtifactByLinkToken, getArtifactForServing } from "../store/index.js";
import {
	parseCookies,
	sessionCookieName,
	verifySession,
} from "./auth.js";

const IMAGE_TYPES = new Set([
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
	"image/svg+xml",
]);

function artifactHeaders(
	contentType: string,
): Record<string, string> {
	const headers: Record<string, string> = {
		"Content-Type": contentType,
		"X-Content-Type-Options": "nosniff",
		"Content-Security-Policy": "default-src 'none'",
	};
	if (!IMAGE_TYPES.has(contentType)) {
		headers["Content-Disposition"] = "attachment";
	}
	return headers;
}

/** Public artifact link — hash the token and look up by link_token_hash. */
export function publicArtifactRoutes(): Hono {
	const app = new Hono();

	app.get("/a/:token", async (c) => {
		const token = c.req.param("token");
		const result = await getArtifactByLinkToken(token);
		if (!result) {
			return c.json({ error: "not found" }, 404);
		}
		const headers = artifactHeaders(result.record.contentType);
		return new Response(new Uint8Array(result.bytes), {
			status: 200,
			headers,
		});
	});

	return app;
}

/** Authenticated artifact serving behind the UI session cookie. */
export function uiArtifactRoutes(): Hono {
	const app = new Hono();

	app.get("/ui/artifacts/:id", async (c) => {
		const adminToken = process.env.FACTORY_ADMIN_TOKEN?.trim();
		if (!adminToken) return c.redirect("/ui/login");
		const cookies = parseCookies(c.req.header("cookie") ?? null);
		const session = cookies[sessionCookieName()];
		if (!session || !verifySession(session, adminToken)) {
			return c.redirect("/ui/login");
		}
		const id = c.req.param("id");
		const result = await getArtifactForServing(id);
		if (!result) {
			return c.json({ error: "not found" }, 404);
		}
		const headers = artifactHeaders(result.contentType);
		return new Response(new Uint8Array(result.bytes), {
			status: 200,
			headers,
		});
	});

	return app;
}
