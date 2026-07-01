import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Absolute path: each package runs `vitest run` from its own dir but shares this
// root config, so a relative setupFiles path would resolve against the package,
// not the repo root.
const setupFile = fileURLToPath(new URL("./vitest.setup.ts", import.meta.url));

export default defineConfig({
  test: {
    passWithNoTests: false,
    // Scrub ambient env (Render local-dev vars, provider API keys, DATABASE_URL)
    // before any test module loads so the suite is hermetic regardless of the
    // shell it runs in. See vitest.setup.ts.
    setupFiles: [setupFile],
    // Use the forks pool rather than worker threads: the threads pool crashes
    // intermittently under Node 24+ (tinypool worker "exited unexpectedly").
    // Forks are slightly slower to spawn but stable across our supported Node
    // line (20 → 26). See docs/mvp-followup.md (F4).
    pool: "forks",
  },
});
