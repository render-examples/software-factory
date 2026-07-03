import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * Build config for the operator UI SPA (`ui/`). Named `vite.ui.config.ts` (not
 * the default `vite.config.ts`) so vitest's config auto-discovery never picks it
 * up for the server test run. Invoked explicitly via `vite build --config`.
 *
 * The SPA is served by the gateway at `/ui` (see `src/routes/ui.ts`), so assets
 * resolve under `/ui/` and the bundle is emitted into the package's `dist/ui-app`
 * so it ships with the published package (`files: ["dist"]`).
 *
 * `dev:ui` runs the Vite dev server (HMR). The SPA's data/SSE calls are absolute
 * paths (`/runs`, `/events/stream`, …) on the same origin, so in dev they're
 * proxied to a running gateway (default `http://localhost:3000`, override with
 * `GATEWAY_ORIGIN`). Build ignores `server`.
 */
const GATEWAY_ORIGIN = process.env.GATEWAY_ORIGIN ?? "http://localhost:3000";

// Path prefixes the gateway owns; everything else is the SPA itself.
const API_PREFIXES = [
  "/runs", "/inputs", "/threads", "/events", "/schedules",
  "/workflows", "/admin", "/health", "/oauth", "/webhooks", "/connectors",
];

export default defineConfig({
  root: "ui",
  base: "/ui/",
  plugins: [react(), tailwindcss()],
  server: {
    proxy: Object.fromEntries(
      API_PREFIXES.map((p) => [p, { target: GATEWAY_ORIGIN, changeOrigin: true }]),
    ),
  },
  build: {
    outDir: "../dist/ui-app",
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
  },
});
