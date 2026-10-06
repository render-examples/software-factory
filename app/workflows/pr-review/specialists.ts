import type { TaskContext } from "@renderinc/sdk/workflows";
import { factoryConfig } from "../../../factory.config.js";
import { resolveSpecialists } from "../../agents/index.js";
import type { SpecialistFinding } from "../../contracts/index.js";
import { specialistOutputSchema } from "../../contracts/index.js";
import { agentTask } from "../../tasks/index.js";
import { parseModelJson } from "../../runners/index.js";
import { point } from "../../telemetry/index.js";

export interface SpecialistResult {
	name: string;
	findings: SpecialistFinding[];
	error?: string;
}

/**
 * Run each configured specialist in parallel.
 * A failing specialist is reported in the review rather than failing the run.
 */
export async function runSpecialists(
	ctx: TaskContext,
	opts: {
		runId: string;
		sandboxId: string;
		diff: string;
		specContext: string | null;
		verificationEvidence: string;
	},
): Promise<SpecialistResult[]> {
	const names = factoryConfig.review.specialists;
	const agents = resolveSpecialists(names);

	const message = buildSpecialistMessage(
		opts.diff,
		opts.specContext,
		opts.verificationEvidence,
	);

	const tasks = agents.map((agent) => {
		const task = agentTask(agent);
		return ctx
			.run(task, {
				runId: opts.runId,
				message,
				sandboxId: opts.sandboxId,
			})
			.then((raw) => {
				const parsed = parseModelJson(specialistOutputSchema, raw);
				const configName = names[agents.indexOf(agent)] ?? agent.id;
				return {
					name: configName,
					findings: parsed?.findings ?? [],
				} as SpecialistResult;
			})
			.catch(async (err) => {
				const configName = names[agents.indexOf(agent)] ?? agent.id;
				const msg = err instanceof Error ? err.message : String(err);
				await point(opts.runId, "specialist.error", {
					specialist: configName,
					error: msg.slice(0, 500),
				}).catch(() => {});
				return {
					name: configName,
					findings: [],
					error: msg.slice(0, 500),
				} as SpecialistResult;
			});
	});

	return Promise.all(tasks);
}

function buildSpecialistMessage(
	diff: string,
	specContext: string | null,
	verificationEvidence: string,
): string {
	const parts = [`## Diff\n\n\`\`\`diff\n${diff.slice(0, 150_000)}\n\`\`\``];
	if (specContext) {
		parts.push(`## Spec context\n\n${specContext}`);
	}
	if (verificationEvidence) {
		parts.push(`## Verification evidence\n\n${verificationEvidence}`);
	}
	return parts.join("\n\n");
}
