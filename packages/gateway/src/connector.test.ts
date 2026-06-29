import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConnectors } from "../src/index.js";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ra-conn-"));
  // tools/github/index.ts contributes a connector via a named `connectors` export.
  await mkdir(join(dir, "tools", "github"), { recursive: true });
  await writeFile(
    join(dir, "tools", "github", "index.ts"),
    [
      `export default { id: "github", resolve: async () => ({ tools: [], close: async () => {} }) };`,
      `export const connectors = [{ key: "github", name: "GitHub", handle: async () => ({ workflow: "code-review", trigger: "github.push" }) }];`,
    ].join("\n") + "\n",
  );
  // A tool with no connectors export is simply skipped.
  await mkdir(join(dir, "tools", "plain"), { recursive: true });
  await writeFile(join(dir, "tools", "plain", "index.ts"), `export default { id: "plain", resolve: async () => ({ tools: [], close: async () => {} }) };\n`);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("loadConnectors", () => {
  it("discovers package-contributed connectors from tools' `connectors` export", async () => {
    const connectors = await loadConnectors(dir);
    expect([...connectors.keys()]).toEqual(["github"]);
    const match = await connectors.get("github")!.handle(new Request("http://x"), { env: () => undefined, logger: { debug() {}, info() {}, warn() {}, error() {} } });
    expect(match).toEqual({ workflow: "code-review", trigger: "github.push" });
  });

  it("returns empty when there is no tools/ directory", async () => {
    expect((await loadConnectors(join(dir, "nope"))).size).toBe(0);
  });
});
