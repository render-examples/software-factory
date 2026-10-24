import { z } from "zod";
import type { SandboxApi, SandboxClient } from "./client.js";
import { errorMessage } from "./shell.js";
import { APP_DIR } from "./types.js";

type NetworkPolicy = NonNullable<NonNullable<Parameters<SandboxApi["create"]>[0]>["networkPolicy"]>;

/**
 * Allow-all egress for every sandbox, in the shape the API accepts, `{ type }`. SDK 1.2.0's types still describe
 * the older `{ default, allowedDomains }` shape.
 */
export const ALLOW_ALL_EGRESS = { type: "allow-all" } as unknown as NetworkPolicy;

const SandboxInfo = z.object({
	runAs: z.string().min(1),
	uid: z.number().int(),
	node: z.string(),
	runnerNonDumpable: z.boolean(),
	selfTest: z.looseObject({ ok: z.literal(true) }),
});
type SandboxInfo = z.infer<typeof SandboxInfo>;

/** Runs verify.sh, which fails unless the sandbox is as built, and parses the JSON line it prints last. */
export async function verifySandbox(client: SandboxClient, id: string, opts: { waitReady?: boolean } = {}): Promise<SandboxInfo> {
	const res = await client.exec(id, `bash ${APP_DIR}/verify.sh`, { timeoutMs: client.t.verifyTimeoutMs, waitReady: opts.waitReady });
	if (res.exitCode !== 0) throw new Error(`verify.sh exited ${res.exitCode}: ${(res.stderr || res.stdout).trim().slice(-2000)}`);
	const last = res.stdout.trim().split("\n").at(-1) ?? "";
	try {
		return SandboxInfo.parse(JSON.parse(last));
	} catch (err) {
		throw new Error(`unexpected verify.sh output ${JSON.stringify(last.slice(0, 300))}: ${errorMessage(err)}`);
	}
}
