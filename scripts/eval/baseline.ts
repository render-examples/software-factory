import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { EvalRun } from "./suite.js";

const Baseline = z.object({
	schemaVersion: z.literal(1),
	results: z.array(
		z.object({
			id: z.string(),
			pass: z.boolean(),
			passRate: z.number().min(0).max(1),
		}),
	),
	metadata: z.object({
		repo: z.string(),
		expectedFixtureSha: z.string(),
	}),
});

export type EvalBaseline = z.infer<typeof Baseline>;

export async function readBaseline(path: string): Promise<EvalBaseline> {
	return Baseline.parse(JSON.parse(await readFile(path, "utf8")));
}

/** Regressions only: improvements and newly added cases are reported by the normal result table. */
export function compareBaseline(run: EvalRun, baseline: EvalBaseline): string[] {
	if (run.metadata.repo !== baseline.metadata.repo) {
		throw new Error(`baseline is for ${baseline.metadata.repo}, not ${run.metadata.repo}`);
	}
	if (run.metadata.expectedFixtureSha !== baseline.metadata.expectedFixtureSha) {
		throw new Error(
			`baseline fixture ${baseline.metadata.expectedFixtureSha} differs from candidate ${run.metadata.expectedFixtureSha}; compare only identical fixtures`,
		);
	}
	const candidate = new Map(run.results.map((result) => [result.id, result]));
	const regressions: string[] = [];
	for (const previous of baseline.results) {
		const current = candidate.get(previous.id);
		if (!current) {
			regressions.push(`${previous.id}: missing from the candidate run`);
		} else if (previous.pass && !current.pass) {
			regressions.push(`${previous.id}: passed in the baseline and failed in the candidate`);
		} else if (current.passRate < previous.passRate) {
			regressions.push(
				`${previous.id}: pass rate fell from ${(previous.passRate * 100).toFixed(0)}% to ${(current.passRate * 100).toFixed(0)}%`,
			);
		}
	}
	return regressions;
}
