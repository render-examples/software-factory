import { readFile } from "node:fs/promises";
import { dirname, join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono, type Context } from "hono";

const HERE = dirname(fileURLToPath(import.meta.url));

// Candidate locations for the built SPA (`vite build` → `dist/ui-app`). The first
// covers the published/built layout (dist/routes → dist/ui-app); the second covers
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

async function readFromUiDirs(relative: string): Promise<string | null> {
  for (const dir of UI_DIRS) {
    try {
      return await readFile(join(dir, relative), "utf8");
    } catch {
      /* try next */
    }
  }
  return null;
}

const NOT_BUILT_HTML = `<!doctype html><meta charset="utf-8" />
<body style="font-family:system-ui;padding:2rem;color:#444">
<h2>Operator UI not built</h2>
<p>Run <code>pnpm --filter @render-agents/gateway build</code> (or <code>build:ui</code>) to produce the SPA bundle.</p>
</body>`;

/**
 * Serves the operator UI SPA (a Vite + React build) at `/ui`. The shell + assets
 * load without auth (data fetches carry the API key); registered before the auth
 * middleware. All data comes from the gateway's existing API routes.
 */
export function uiRoutes() {
  const app = new Hono();

  // Built static assets (hashed filenames under /ui/assets/).
  app.get("/ui/assets/:file", async (c) => {
    const file = c.req.param("file");
    // Guard against path traversal — assets are flat, hashed filenames.
    if (file.includes("..") || file.includes("/")) return c.text("not found", 404);
    const body = await readFromUiDirs(join("assets", file));
    if (body === null) return c.text("not found", 404);
    const type = CONTENT_TYPES[extname(file)] ?? "application/octet-stream";
    return c.body(body, 200, { "Content-Type": type, "Cache-Control": "public, max-age=31536000, immutable" });
  });

  // Shell + SPA client-side routing fallback.
  const serveShell = async (c: Context) => {
    const html = await readFromUiDirs("index.html");
    return c.html(html ?? NOT_BUILT_HTML);
  };
  app.get("/ui", serveShell);
  app.get("/ui/*", serveShell);

  return app;
}
