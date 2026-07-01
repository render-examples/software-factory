/**
 * Hermetic test environment.
 *
 * Tests must behave identically in CI and on a developer's machine — including
 * inside a `render workflows dev` shell, where the Render CLI exports local-dev
 * vars, or a shell with provider API keys / a DATABASE_URL exported for manual
 * runs. Those ambient vars otherwise change dispatcher selection, model
 * auto-detection, and store selection, silently breaking assertions (a real
 * dispatcher hits a socket; a real model makes a network call; createStore()
 * picks Postgres). Scrub them once, before any test module loads.
 *
 * Preserved on purpose:
 * - `TEST_DATABASE_URL` — the explicit opt-in for Postgres-gated suites.
 * - `RENDER_AGENTS_API_KEY` — the gateway's own auth key; auth tests set/clear
 *   it themselves within the test body.
 *
 * Individual tests that exercise env-driven behavior (e.g. dispatcher detection)
 * still set/unset these within the test and are unaffected — this only clears
 * the *ambient* values present at worker startup.
 */
const SCRUB = [
  // Render Workflows dispatcher selection (local-dev + in-container signals).
  "RENDER_USE_LOCAL_DEV",
  "RENDER_LOCAL_DEV_URL",
  "RENDER_SDK_SOCKET_PATH",
  "RENDER_WORKFLOW_SLUG",
  "RENDER_API_KEY",
  // Model auto-detection — tests use mockModel or assert "No model configured".
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  // Store auto-detection — the default store must be in-memory unless a suite
  // explicitly opts into Postgres via TEST_DATABASE_URL.
  "DATABASE_URL",
] as const;

for (const key of SCRUB) {
  delete process.env[key];
}
