import {
	createPostgresFactoryStore,
	type RunRecord,
} from "#factory/store";
import { factoryRepository } from "../app/lib/factory-config.js";

const args = process.argv.slice(2);
const json = args.includes("--json");
const runArg = valueAfter(args, "--run");
const issueArg = valueAfter(args, "--issue");
if ((runArg ? 1 : 0) + (issueArg ? 1 : 0) !== 1) {
	throw new Error("Provide exactly one of --run <id> or --issue <number>");
}

const store = createPostgresFactoryStore({
	applicationName: "render-factory-run-status",
	max: 1,
});
try {
	await store.verifySchema();
	let run: RunRecord | null = null;
	if (runArg) {
		run = await store.runs.getRun(runArg);
	} else {
		const issueNumber = Number(issueArg);
		if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
			throw new Error("--issue must be a positive integer");
		}
		const repository = factoryRepository();
		run =
			(
				await store.runs.findRunsByLink(
					"github.issue",
					`${repository.fullName}#${issueNumber}`,
					1,
				)
			)[0] ?? null;
	}
	if (!run) {
		console.error("No matching factory run found");
		process.exitCode = 1;
	} else {
		const [events, links, children] = await Promise.all([
			store.events.readRun(run.id, { limit: 500 }),
			store.runs.listLinks(run.id),
			store.runs.listRuns({ rootRunId: run.rootRunId, limit: 500 }),
		]);
		const resultStatus =
			run.result &&
			typeof run.result === "object" &&
			"status" in run.result &&
			typeof run.result.status === "string"
				? run.result.status
				: undefined;
		const snapshot = {
			run: {
				id: run.id,
				rootRunId: run.rootRunId,
				parentRunId: run.parentRunId,
				kind: run.kind,
				name: run.name,
				status: run.status,
				resultStatus,
				errorCode: run.errorCode,
				failureCount: run.failureCount,
				usage: {
					inputTokens: run.totalInputTokens,
					outputTokens: run.totalOutputTokens,
					modelCalls: run.totalModelCalls,
				},
				createdAt: run.createdAt,
				startedAt: run.startedAt,
				finishedAt: run.finishedAt,
			},
			links: links.map(({ kind, externalId, url }) => ({
				kind,
				externalId,
				url,
			})),
			children: children
				.filter((child) => child.id !== run?.id)
				.map((child) => ({
					id: child.id,
					kind: child.kind,
					name: child.name,
					status: child.status,
					parentStepKey: child.parentStepKey,
				})),
			events: events.map((event) => ({
				seq: event.seq,
				ts: event.ts,
				type: event.type,
				stepKey: event.stepKey,
				agentName: event.agentName,
				executionId: event.executionId,
			})),
		};
		if (json) {
			console.log(JSON.stringify(snapshot));
		} else {
			console.log(
				[
					`Run: ${snapshot.run.id}`,
					`Kind: ${snapshot.run.kind}`,
					`Name: ${snapshot.run.name}`,
					`Status: ${snapshot.run.status}${resultStatus ? ` (${resultStatus})` : ""}`,
					`Started: ${snapshot.run.startedAt ?? "not started"}`,
					`Finished: ${snapshot.run.finishedAt ?? "not finished"}`,
					`Usage: ${snapshot.run.usage.inputTokens} input / ${snapshot.run.usage.outputTokens} output tokens across ${snapshot.run.usage.modelCalls} calls`,
					"",
					"Events:",
					...snapshot.events.map(
						(event) =>
							`  ${String(event.seq).padStart(3)}  ${event.type}${event.stepKey ? `  ${event.stepKey}` : ""}`,
					),
				].join("\n"),
			);
		}
	}
} finally {
	await store.close();
}

function valueAfter(values: string[], flag: string): string | undefined {
	const index = values.indexOf(flag);
	return index >= 0 ? values[index + 1] : undefined;
}
