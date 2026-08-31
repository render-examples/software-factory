import { createHash, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { closeKv, kv } from "#factory/sdk";
import {
	abandonIntake,
	claimExecution,
	claimIntake,
	clearCheckpoints,
	completeIntake,
	getCheckpoint,
	incrementFailureCount,
	markIntakeDispatched,
	putCheckpoint,
	refreshExecution,
	releaseExecution,
} from "../../lib/run-store.js";
import {
	appendSlackMessage,
	claimSlackDelivery,
	claimSlackThread,
	getSlackThread,
	markSlackDispatched,
	releaseSlackThread,
} from "../../lib/slack-state.js";

afterAll(async () => {
	await closeKv();
});

describe.skipIf(process.env.RUN_LIVE_INTEGRATION !== "1")(
	"live Key Value integration",
	() => {
		it("round-trips and expires a factory probe", async () => {
			if (!process.env.REDIS_URL) {
				throw new Error("REDIS_URL is required for integration tests");
			}
			const client = await kv();
			const key = `factory:integration:${randomUUID()}`;
			await client.set(key, "ok", { EX: 30 });
			expect(await client.get(key)).toBe("ok");
			await client.del(key);
			expect(await client.get(key)).toBeNull();
		});

		it("executes the atomic delivery and checkpoint scripts", async () => {
			const suffix = randomUUID().replaceAll("-", "");
			const firstAttempt = `integration-${suffix}`;
			const secondAttempt = `integration2-${suffix}`;
			const issueNumber = Math.floor(Math.random() * 1_000_000) + 1_000_000;
			const repository = "integration/factory";

			expect(await claimIntake(repository, issueNumber, firstAttempt)).toBe(
				"claimed",
			);
			await markIntakeDispatched(repository, firstAttempt);
			expect(await claimIntake(repository, issueNumber, firstAttempt)).toBe(
				"dispatched",
			);
			await putCheckpoint(firstAttempt, "probe", { ok: true });
			expect(
				await getCheckpoint<{ ok: boolean }>(firstAttempt, "probe"),
			).toEqual({ found: true, value: { ok: true } });
			expect(await claimExecution(firstAttempt, "execution-1")).toBe(true);
			expect(await claimExecution(firstAttempt, "execution-2")).toBe(false);
			await refreshExecution(firstAttempt, "execution-1");
			await releaseExecution(firstAttempt, "execution-1");
			expect(await incrementFailureCount(firstAttempt)).toBe(1);
			expect(await incrementFailureCount(firstAttempt)).toBe(2);

			await completeIntake(repository, issueNumber, firstAttempt);
			expect(await claimIntake(repository, issueNumber, secondAttempt)).toBe(
				"claimed",
			);

			await abandonIntake(repository, issueNumber, secondAttempt);
			await abandonIntake(repository, issueNumber, firstAttempt);
			await clearCheckpoints(firstAttempt, ["probe", "failure-count"]);
		});

		it("executes atomic Slack delivery, memory, and lock scripts", async () => {
			const client = await kv();
			const eventId = `Ev-${randomUUID()}`;
			const threadId = `C-${randomUUID()}`;
			const hash = (value: string) =>
				createHash("sha256").update(value).digest("hex");

			expect(await claimSlackDelivery(eventId)).toBe("claimed");
			await markSlackDispatched(eventId);
			expect(await claimSlackDelivery(eventId)).toBe("dispatched");
			const message = {
				eventId,
				role: "user" as const,
				content: "hello",
				ts: new Date().toISOString(),
			};
			expect(await appendSlackMessage(threadId, message)).toBe(true);
			expect(await appendSlackMessage(threadId, message)).toBe(false);
			expect(await getSlackThread(threadId)).toEqual([message]);
			expect(await claimSlackThread(threadId, eventId)).toBe(true);
			expect(await claimSlackThread(threadId, "other")).toBe(false);
			await releaseSlackThread(threadId, eventId);

			await client.del([
				`slack:delivery:${hash(eventId)}`,
				`slack:message:${hash(eventId)}`,
				`slack:thread:${hash(threadId)}`,
				`slack:lock:${hash(threadId)}`,
			]);
		});
	},
);
