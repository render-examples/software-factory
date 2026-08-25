/**
 * Quick smoke test for the Render Sandbox integration.
 * Provisions a sandbox, runs commands, writes/reads files, then terminates.
 *
 * Usage:
 *   set -a; source ../../.env; source .env.localdev; set +a
 *   pnpm exec tsx scripts/test-sandbox.ts
 */
import { RenderSandboxProvider } from "@render-agents/sandbox-render";
import { collectExecOutput } from "@render-agents/engine";

async function main() {
  console.log("--- Render Sandbox E2E Test ---\n");

  const provider = new RenderSandboxProvider();
  console.log("1. Creating sandbox...");
  const t0 = Date.now();
  const sandbox = await provider.create({ timeoutSeconds: 300 });
  console.log(`   Created sandbox ${sandbox.id} in ${Date.now() - t0}ms`);

  console.log("\n2. Checking status...");
  const status = await sandbox.status();
  console.log(`   Status: ${status}`);

  console.log("\n3. Running 'uname -a'...");
  const unameEvents = await sandbox.exec("uname -a");
  const uname = await collectExecOutput(unameEvents);
  console.log(`   Output: ${uname.output.trim()}`);
  console.log(`   Exit code: ${uname.exitCode}`);

  console.log("\n4. Writing hello.py...");
  await sandbox.writeFile("/workspace/hello.py", 'print("Hello from Render Sandbox!")\n');
  console.log("   Written.");

  console.log("\n5. Reading hello.py back...");
  const content = await sandbox.readFile("/workspace/hello.py");
  console.log(`   Content: ${content.trim()}`);

  console.log("\n6. Running hello.py...");
  const pyEvents = await sandbox.exec("python3 /workspace/hello.py");
  const py = await collectExecOutput(pyEvents);
  console.log(`   Output: ${py.output.trim()}`);
  console.log(`   Exit code: ${py.exitCode}`);

  console.log("\n7. Multi-step: install package + use it...");
  const installEvents = await sandbox.exec("pip install cowsay -q && python3 -c 'import cowsay; cowsay.cow(\"Sandbox works!\")'");
  const install = await collectExecOutput(installEvents);
  console.log(`   Output:\n${install.output}`);

  console.log("\n8. Listing /workspace...");
  const entries = await sandbox.listDir("/workspace");
  console.log(`   Entries: ${entries.join(", ")}`);

  console.log("\n9. Reconnecting to same sandbox...");
  const reconnected = await provider.connect(sandbox.id);
  const statusAfter = await reconnected.status();
  console.log(`   Reconnected, status: ${statusAfter}`);

  console.log("\n10. Terminating sandbox...");
  await sandbox.terminate();
  console.log("    Done.");

  console.log("\n--- All sandbox tests passed! ---");
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
