#!/usr/bin/env node
/**
 * NFR gate: `@render-agents/sdk` minified footprint < 100KB.
 *
 * Measures the SDK package's *own* code, minified (its declared dependencies —
 * engine, store, zod, yaml — install separately and are not bundled into the
 * published package). Run after building the workspace.
 */
import esbuild from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LIMIT_KB = 100;

const entry = join(ROOT, "packages/sdk/dist/index.js");
const result = await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  minify: true,
  format: "esm",
  platform: "node",
  packages: "external", // deps install separately; measure the SDK's own footprint
  write: false,
  logLevel: "silent",
});

const bytes = result.outputFiles[0].contents.length;
const kb = bytes / 1024;
console.log(`@render-agents/sdk minified footprint: ${kb.toFixed(1)} KB (limit ${LIMIT_KB} KB)`);

if (kb > LIMIT_KB) {
  console.error(`✗ bundle-size gate FAILED: ${kb.toFixed(1)} KB > ${LIMIT_KB} KB`);
  process.exit(1);
}
console.log("✓ bundle-size gate passed");
