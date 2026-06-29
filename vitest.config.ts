import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    passWithNoTests: false,
    // Use the forks pool rather than worker threads: the threads pool crashes
    // intermittently under Node 24+ (tinypool worker "exited unexpectedly").
    // Forks are slightly slower to spawn but stable across our supported Node
    // line (20 → 26). See docs/mvp-followup.md (F4).
    pool: "forks",
  },
});
