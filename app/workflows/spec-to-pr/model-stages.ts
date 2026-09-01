import { createHash } from "node:crypto";
import type { z } from "zod";
import type { AgentRunContext } from "#factory/sdk";
import {
	analysisTask,
	correctnessTask,
	implementTask,
	judgeTask,
	securityTask,
	selfReviewTask,
	testsTask,
	triageTask,
} from "../../tasks/index.js";
import type { GitHub, RepoRef } from "../../lib/github.js";
import { parseModelJson } from "../../lib/model-json.js";
import { resolveAgentResult } from "../shared/resolve-agent-result.js";
import {
	decisionSchema,
	type ImplementationCheckpoint,
	type ImplementationReport,
	implementationSchema,
	type IntakeCheckpoint,
	type ReviewDecision,
	type ReviewerOutput,
	reviewerOutputSchema,
	type SelfReviewResult,
	selfReviewSchema,
	triageSchema,
} from "./contracts.js";
import { issueContext, sandboxContext } from "./context.js";

interface ParentRun {
	rootRunId: string;
	runId: string;
	stepKey: string;
	generation: number;
}

function childRun(
	parent: ParentRun,
	agentName: string,
	invocation = "primary",
): AgentRunContext {
	return {
		id: createHash("sha256")
			.update(
				`${parent.runId}\0${parent.stepKey}\0${parent.generation}\0${agentName}\0${invocation}`,
			)
			.digest("hex"),
		rootRunId: parent.rootRunId,
		parentRunId: parent.runId,
		parentStepKey: parent.stepKey,
	};
}

export async function parseWithRepair<T>(
	schema: z.ZodType<T>,
	raw: string,
	stage: string,
	repair: () => Promise<string>,
): Promise<T> {
	const parsed = parseModelJson(schema, raw);
	if (parsed) return parsed;

	console.warn(
		JSON.stringify({
			event: "model_output_parse_failure",
			stage,
			attempt: 1,
		}),
	);
	const repairedRaw = await resolveAgentResult(await repair());
	const repaired = parseModelJson(schema, repairedRaw);
	if (repaired) return repaired;
	console.warn(
		JSON.stringify({
			event: "model_output_parse_failure",
			stage,
			attempt: 2,
		}),
	);
	throw new Error(`${stage} returned invalid structured output twice`);
}

interface LoadIntakeOptions {
	gh: GitHub;
	repo: RepoRef;
	issueNumber: number;
	triggerLabel: string;
	run: ParentRun;
}

export async function loadIntake({
	gh,
	repo,
	issueNumber,
	triggerLabel,
	run,
}: LoadIntakeOptions): Promise<IntakeCheckpoint> {
	const issue = await gh.getIssue(repo, issueNumber);
	if (!issue.labels.includes(triggerLabel)) {
		throw new Error(`Issue no longer has the "${triggerLabel}" label`);
	}
	const comments = await gh.listIssueComments(repo, issueNumber);
	const workItem = issueContext(issue, comments);
	const triageRaw = await resolveAgentResult(
		await triageTask({
			message: workItem,
			run: childRun(run, "triage"),
		}),
	);
	return {
		issue,
		workItem,
		triage: await parseWithRepair(
			triageSchema,
			triageRaw,
			"triage",
			async () =>
				await triageTask({
					message: `${workItem}\n\nYour previous response was not valid JSON. Return only the required JSON object.`,
					run: childRun(run, "triage", "repair"),
				}),
		),
	};
}

interface RunAnalysisOptions {
	workItem: string;
	sandboxId: string;
	run: ParentRun;
}

export async function runAnalysis({
	workItem,
	sandboxId,
	run,
}: RunAnalysisOptions): Promise<string> {
	return resolveAgentResult(
		await analysisTask({
			message: `${sandboxContext()}\n\nWork item:\n${workItem}`,
			sandboxId,
			run: childRun(run, "analyst"),
		}),
	);
}

export function requireImplementationReport(raw: string): ImplementationReport {
	const report = parseModelJson(implementationSchema, raw);
	if (!report) {
		throw new Error("Implementer returned invalid structured output");
	}
	return report;
}

interface RunImplementationOptions {
	message: string;
	sandboxId: string;
	run: ParentRun;
}

export async function runImplementation({
	message,
	sandboxId,
	run,
}: RunImplementationOptions): Promise<ImplementationCheckpoint> {
	const raw = await resolveAgentResult(
		await implementTask({
			message,
			sandboxId,
			run: childRun(run, "implementer"),
		}),
	);
	return { raw, report: requireImplementationReport(raw) };
}

interface RunSelfReviewOptions {
	diff: string;
	workItem: string;
	run: ParentRun;
}

export async function runSelfReview({
	diff,
	workItem,
	run,
}: RunSelfReviewOptions): Promise<SelfReviewResult> {
	const raw = await resolveAgentResult(
		await selfReviewTask({
			message: `Work item:\n${workItem}\n\nComplete diff:\n${diff}`,
			run: childRun(run, "self-review"),
		}),
	);
	return parseWithRepair(
		selfReviewSchema,
		raw,
		"self-review",
		async () =>
			await selfReviewTask({
				message: `Work item:\n${workItem}\n\nComplete diff:\n${diff}\n\nYour previous response was not valid JSON. Return only the required JSON object.`,
				run: childRun(run, "self-review", "repair"),
			}),
	);
}

function parseReviewerOutput(
	raw: string,
	source: string,
): { parsed: ReviewerOutput | null; raw: string } {
	const parsed = parseModelJson(reviewerOutputSchema, raw);
	if (!parsed) {
		console.warn(
			JSON.stringify({
				event: "reviewer_structured_parse_fallback",
				source,
			}),
		);
	}
	return { parsed, raw };
}

const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 } as const;

function formatReviewerSection(
	title: string,
	review: { parsed: ReviewerOutput | null; raw: string },
): string {
	if (!review.parsed || review.parsed.findings.length === 0) {
		return `## ${title}\n${review.raw}`;
	}
	const findings = [...review.parsed.findings].sort(
		(a, b) =>
			SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
			b.confidence - a.confidence,
	);
	const lines = findings.map(
		(f) =>
			`- **${f.severity.toUpperCase()}** (confidence: ${f.confidence}) \`${f.file}\`: ${f.description}`,
	);
	return `## ${title}\n${lines.join("\n")}`;
}

interface RunReviewOptions {
	diff: string;
	implementation: ImplementationCheckpoint;
	run: ParentRun;
}

export async function runReview({
	diff,
	implementation,
	run,
}: RunReviewOptions): Promise<ReviewDecision> {
	const [securityRaw, correctnessRaw, testRaw] = await Promise.all(
		[
			securityTask({
				message: diff,
				run: childRun(run, "security"),
			}),
			correctnessTask({
				message: diff,
				run: childRun(run, "correctness"),
			}),
			testsTask({
				message: `${implementation.raw}\n\nComplete diff:\n${diff}`,
				run: childRun(run, "tests"),
			}),
		].map(async (result) => resolveAgentResult(await result)),
	);
	const securityReview = parseReviewerOutput(securityRaw, "security");
	const correctnessReview = parseReviewerOutput(correctnessRaw, "correctness");
	const testReview = parseReviewerOutput(testRaw, "tests");

	const details = [
		formatReviewerSection("Security", securityReview),
		formatReviewerSection("Correctness", correctnessReview),
		formatReviewerSection("Tests", testReview),
	].join("\n\n");
	const judgeRaw = await resolveAgentResult(
		await judgeTask({
			message: `${details}\n\nComplete diff:\n${diff}`,
			run: childRun(run, "judge"),
		}),
	);
	const decision = await parseWithRepair(
		decisionSchema,
		judgeRaw,
		"judge",
		async () =>
			await judgeTask({
				message: `${details}\n\nComplete diff:\n${diff}\n\nYour previous response was not valid JSON. Return only the required JSON object.`,
				run: childRun(run, "judge", "repair"),
			}),
	);
	return {
		decision: decision.decision,
		riskTier: decision.riskTier,
		summary: decision.summary,
		topFindings: decision.topFindings,
		details,
	};
}
