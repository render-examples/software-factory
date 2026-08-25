#!/usr/bin/env node
/**
 * Credential boundary check: packages/ must NOT directly import provider SDKs
 * (e.g. @anthropic-ai/sdk, openai). Provider integrations live exclusively in
 * packages/engine/src/clients/ — the only allowed location. Everything else
 * consumes the ModelClient interface, never a concrete SDK.
 *
 * Allowed: packages/engine/src/clients/**
 * Forbidden elsewhere in packages/: import from "@anthropic-ai/sdk" | "openai"
 */
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const PROVIDER_PATTERN = /from\s+["'](@anthropic-ai\/sdk|openai)(\/[^"']*)?["']/;
const ALLOWED_DIR = "packages/engine/src/clients/";

const files = execSync('find packages -name "*.ts" -not -path "*/node_modules/*" -not -path "*/dist/*"', {
  encoding: "utf-8",
  cwd: new URL("..", import.meta.url).pathname,
}).trim().split("\n").filter(Boolean);

const violations = [];

for (const file of files) {
  if (file.startsWith(ALLOWED_DIR)) continue;

  const fullPath = new URL(`../${file}`, import.meta.url).pathname;
  let content;
  try {
    content = readFileSync(fullPath, "utf-8");
  } catch {
    continue;
  }

  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (PROVIDER_PATTERN.test(lines[i])) {
      violations.push({ file, line: i + 1, text: lines[i].trim() });
    }
  }
}

if (violations.length > 0) {
  console.error("Credential boundary violation: provider SDK imports outside allowed zone\n");
  console.error(`  Allowed: ${ALLOWED_DIR}\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  ${v.text}`);
  }
  console.error(`\n${violations.length} violation(s). Use the ModelClient interface instead.`);
  process.exit(1);
}

console.log("credential-boundary: OK (no provider SDK imports outside engine/clients/)");
