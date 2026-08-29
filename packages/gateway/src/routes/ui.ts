import { readFile } from "node:fs/promises";
import { dirname, join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono, type Context } from "hono";

const HERE = dirname(fileURLToPath(import.meta.url));

// Built SPA locations: published layout (dist/routes → dist/ui-app) vs
// running from source under vitest/tsx (src/routes → dist/ui-app).
const UI_DIRS = [
  join(HERE, "..", "ui-app"),
  join(HERE, "..", "..", "dist", "ui-app"),
];

const CONTENT_TYPES: Record<string, string> = {
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

const UI_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join("; ");

const SECURITY_HEADERS = {
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
} as const;

function withUiHeaders(extra: Record<string, string> = {}, includeCsp = false): Record<string, string> {
  return {
    ...SECURITY_HEADERS,
    ...(includeCsp ? { "Content-Security-Policy": UI_CSP } : {}),
    ...extra,
  };
}

async function readFromUiDirs(relative: string): Promise<Buffer | null> {
  for (const dir of UI_DIRS) {
    try {
      // Buffer (no encoding) avoids corrupting binary assets via UTF-8 round-trip (CR-23).
      return await readFile(join(dir, relative));
    } catch {}
  }
  return null;
}

const NOT_BUILT_HTML = `<!doctype html><meta charset="utf-8" />
<body style="font-family:system-ui;padding:2rem;color:#444">
<h2>Operator UI not built</h2>
<p>Run <code>pnpm --filter @render-factory/gateway build</code> (or <code>build:ui</code>) to produce the SPA bundle.</p>
</body>`;

/**
 * Serves the operator UI SPA (a Vite + React build) at `/ui`. The shell + assets
 * load without auth (data fetches carry the API key); registered before the auth
 * middleware. All data comes from the gateway's existing API routes.
 */
export function uiRoutes() {
  const app = new Hono();

  app.get("/ui/assets/:file", async (c) => {
    const file = c.req.param("file");
    // Guard against path traversal; assets are flat, hashed filenames.
    if (file.includes("..") || file.includes("/")) return c.text("not found", 404, withUiHeaders());
    const body = await readFromUiDirs(join("assets", file));
    if (body === null) return c.text("not found", 404, withUiHeaders());
    const type = CONTENT_TYPES[extname(file)] ?? "application/octet-stream";
    return c.body(new Uint8Array(body), 200, withUiHeaders({
      "Content-Type": type,
      "Cache-Control": "public, max-age=31536000, immutable",
    }));
  });

  const serveShell = async (c: Context) => {
    const html = await readFromUiDirs("index.html");
    return c.html(
      html ? html.toString("utf8") : NOT_BUILT_HTML,
      200,
      withUiHeaders({ "Cache-Control": "no-store" }, true),
    );
  };
  app.get("/ui", serveShell);
  app.get("/ui/*", serveShell);

  return app;
}
