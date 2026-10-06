import type { TaskContext } from "@renderinc/sdk/workflows";
import {
	synthesisSchema,
	type Synthesis,
	type SynthesisComment,
} from "../../contracts/index.js";
import type { UxTestOutput } from "../../contracts/ux.js";
import type { VerificationResult } from "../../git/types.js";
import { synthesizer } from "../../agents/reviewers/synthesizer.js";
import { agentTask } from "../../tasks/index.js";
import { parseModelJson } from "../../runners/index.js";
import { validateCommentPositions } from "./diff-positions.js";
import type { SpecialistResult } from "./specialists.js";

export interface SynthesisResult {
	summary: string;
	riskTier: string;
	validComments: SynthesisComment[];
	invalidComments: SynthesisComment[];
}

/**
 * Run the synthesizer agent and validate inline comment positions.
 * Comments outside diff hunks are moved into the summary.
 */
export async function synthesize(
	ctx: TaskContext,
	opts: {
		runId: string;
		diff: string;
		specialistResults: readonly SpecialistResult[];
		verificationResult: VerificationResult;
		uxResults: UxTestOutput | null;
	},
): Promise<SynthesisResult> {
	const task = agentTask(synthesizer);
	const message = buildSynthesisMessage(
		opts.specialistResults,
		opts.verificationResult,
		opts.uxResults,
	);

	const raw = await ctx.run(task, { runId: opts.runId, message });
	const parsed = parseModelJson(synthesisSchema, raw);
	const result: Synthesis = parsed ?? {
		summary: raw.slice(0, 2000),
		riskTier: "medium",
		comments: [],
	};

	const { valid, invalid } = validateCommentPositions(
		result.comments,
		opts.diff,
	);

	let summary = result.summary;
	if (invalid.length > 0) {
		summary += "\n\n**Findings outside diff hunks:**\n";
		for (const c of invalid) {
			summary += `\n- \`${c.path}:${c.line}\`: ${c.body}`;
		}
	}

	return {
		summary,
		riskTier: result.riskTier,
		validComments: valid,
		invalidComments: invalid,
	};
}

function buildSynthesisMessage(
	specialistResults: readonly SpecialistResult[],
	verification: VerificationResult,
	uxResults: UxTestOutput | null,
): string {
	const parts: string[] = [];

	parts.push("## Verification evidence\n");
	parts.push(
		verification.passed
			? "All verification commands passed."
			: `Verification failures:\n${verification.failures}`,
	);
	for (const r of verification.results) {
		parts.push(`- \`${r.command}\`: exit ${r.exitCode} (${r.durationMs}ms)`);
	}

	for (const specialist of specialistResults) {
		parts.push(`\n## ${specialist.name} findings\n`);
		if (specialist.error) {
			parts.push(`Error: ${specialist.error}`);
		} else if (specialist.findings.length === 0) {
			parts.push("No findings.");
		} else {
			for (const f of specialist.findings) {
				parts.push(
					`- **${f.severity}** (${f.confidence}%) \`${f.path}:${f.line}\` — ${f.title}: ${f.body}`,
				);
			}
		}
	}

	if (uxResults && uxResults.results.length > 0) {
		parts.push("\n## UX test results\n");
		for (const r of uxResults.results) {
			parts.push(`- ${r.criterionId ?? "—"}: ${r.verdict} — ${r.observations}`);
		}
	}

	return parts.join("\n");
}
