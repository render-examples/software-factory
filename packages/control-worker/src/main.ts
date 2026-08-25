import { PgRunStore, PgCommandStore } from "@render-agents/store";
import { loadPolicyFile } from "@render-agents/policy";
import { ControlWorker } from "./worker.js";
import { buildCommandHandler } from "./handler.js";

export interface MainOptions {
  hangBeforeAppend?: boolean;
  onReady?: () => void;
}

export async function main(opts: MainOptions = {}): Promise<void> {
  const dbUrl = required("DATABASE_URL");
  const tenantId = required("TENANT_ID");

  const store = new PgRunStore({
    connectionString: dbUrl,
    tenantId,
  });
  await store.init();

  const commands = new PgCommandStore(store.pool, tenantId);
  const policy = loadPolicyFile(process.env.POLICY_PATH ?? "config/policy/policy.json");

  const hang = opts.hangBeforeAppend ?? process.env.HANG_BEFORE_APPEND === "1";

  const handler = buildCommandHandler({
    events: store.events,
    policy,
    ...(hang
      ? {
          beforeAppend: async () => {
            process.stdout.write("CLAIMED_AWAITING_KILL\n");
            await new Promise(() => {});
          },
        }
      : {}),
  });

  const worker = new ControlWorker({
    commands,
    handler,
    workerId: process.env.WORKER_ID ?? `worker-${process.pid}`,
    ...(process.env.VISIBILITY_TIMEOUT_MS
      ? { visibilityTimeoutMs: Number(process.env.VISIBILITY_TIMEOUT_MS) }
      : {}),
    onEvent: (event) => {
      if (event.type !== "idle") process.stdout.write(`${JSON.stringify(event)}\n`);
    },
  });

  worker.start();
  opts.onReady?.();
  process.stdout.write("WORKER_READY\n");

  const shutdown = async (signal: string): Promise<void> => {
    process.stdout.write(`SHUTTING_DOWN ${signal}\n`);
    await worker.stop();
    await store.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
