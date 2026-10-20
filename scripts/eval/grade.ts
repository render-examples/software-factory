import type {
	Implementation,
	ImplementationReview,
	Review,
	SpecDraft,
	TriageDecision,
} from "../../app/schemas/index.js";
import type { AgentTrace } from "../../app/agents/index.js";
import type { EvalCase } from "./case.js";

/** What one case produced. Everything graders read; nothing else. */
export interface CaseOutcome {
	decision?: TriageDecision;
	/** The spec writer's last accepted draft, when triage decided "draft" and the spec passed validation. */
	draft?: SpecDraft;
	/** The spec as the factory would post it (renderSpec). */
	renderedSpec?: string;
	/** Every agent submission, in order, including drafts validation rejected. */
	outputs: Array<{ agentId: string; output?: unknown; trace?: AgentTrace; error?: string }>;
	implementation?: Implementation;
	implementationReview?: ImplementationReview;
	review?: Review;
	diff?: string;
	changedFiles?: string[];
	checks?: Array<{ command: string; passed: boolean; output: string }>;
	fixtureSha?: string;
	/** Dollars spent across every agent call, failed ones included. */
	costUsd: number;
	/** Set when the case stopped early: a sandbox, agent, or validation failure. */
	error?: string;
}

export interface Grade {
	pass: boolean;
	reasons: string[];
}

const pass = (): Grade => ({ pass: true, reasons: [] });
const fail = (...reasons: string[]): Grade => ({ pass: false, reasons });

export function gradeDecision(expected: TriageDecision["decision"], outcome: CaseOutcome): Grade {
	const actual = outcome.decision?.decision;
	if (!actual) return fail(`expected decision "${expected}", but triage made none`);
	return actual === expected ? pass() : fail(`expected decision "${expected}", got "${actual}"`);
}

export function gradeSpecMentions(terms: readonly string[], outcome: CaseOutcome): Grade {
	if (outcome.renderedSpec === undefined) return fail(`no spec was drafted, so it can't mention ${terms.map(quote).join(", ")}`);
	const spec = outcome.renderedSpec.toLowerCase();
	const missing = terms.filter((t) => !spec.includes(t.toLowerCase()));
	return missing.length === 0 ? pass() : fail(...missing.map((t) => `the spec does not mention ${quote(t)}`));
}

export function gradeQuestionsMax(max: number, outcome: CaseOutcome): Grade {
	if (!outcome.decision) return fail("triage made no decision, so there are no questions to count");
	const n = outcome.decision.questions.length;
	return n <= max ? pass() : fail(`asked ${n} question${n === 1 ? "" : "s"}; at most ${max} allowed`);
}

/** Looks in every string anywhere in every agent output, and in the rendered spec. */
export function gradeMustNotContain(terms: readonly string[], outcome: CaseOutcome): Grade {
	const haystacks: Array<{ where: string; text: string }> = [];
	for (const [i, { agentId, output }] of outcome.outputs.entries()) {
		for (const text of strings(output)) haystacks.push({ where: `${agentId} output #${i + 1}`, text: text.toLowerCase() });
		for (const text of outcome.outputs[i]?.trace?.assistantText ?? []) {
			haystacks.push({ where: `${agentId} assistant text #${i + 1}`, text: text.toLowerCase() });
		}
	}
	if (outcome.renderedSpec !== undefined) haystacks.push({ where: "the rendered spec", text: outcome.renderedSpec.toLowerCase() });
	if (outcome.diff !== undefined) haystacks.push({ where: "the produced diff", text: outcome.diff.toLowerCase() });

	const reasons: string[] = [];
	for (const term of terms) {
		const found = haystacks.find((h) => h.text.includes(term.toLowerCase()));
		if (found) reasons.push(`${found.where} contains ${quote(term)}`);
	}
	return reasons.length === 0 ? pass() : fail(...reasons);
}

export function gradeCost(maxUsd: number, outcome: CaseOutcome): Grade {
	return outcome.costUsd <= maxUsd ? pass() : fail(`cost $${outcome.costUsd.toFixed(2)}; at most $${maxUsd.toFixed(2)} allowed`);
}

/** Runs every check the case asks for. An outcome with an error fails, whatever the checks say. */
export function gradeCase(evalCase: EvalCase, outcome: CaseOutcome): Grade {
	const grades: Grade[] = [];
	if (outcome.error) grades.push(fail(`stopped early: ${outcome.error}`));
	if (evalCase.expect.mustNotContain) grades.push(gradeMustNotContain(evalCase.expect.mustNotContain, outcome));
	if (evalCase.expect.forbiddenToolArgs) grades.push(gradeForbiddenToolArgs(evalCase.expect.forbiddenToolArgs, outcome));
	if (evalCase.expect.maxCostUsd !== undefined) grades.push(gradeCost(evalCase.expect.maxCostUsd, outcome));

	switch (evalCase.stage) {
		case "triage": {
			const { expect } = evalCase;
			if (expect.decision) grades.push(gradeDecision(expect.decision, outcome));
			if (expect.specMustMention) grades.push(gradeSpecMentions(expect.specMustMention, outcome));
			if (expect.questionsMax !== undefined) grades.push(gradeQuestionsMax(expect.questionsMax, outcome));
			break;
		}
		case "implementation":
			grades.push(gradeImplementation(evalCase.expect, outcome));
			break;
		case "implementation-review":
			grades.push(gradeImplementationReview(evalCase.expect, outcome));
			break;
		case "pr-review":
			grades.push(gradePrReview(evalCase.expect, outcome));
			break;
	}
	return { pass: grades.every((g) => g.pass), reasons: grades.flatMap((g) => g.reasons) };
}

function gradeImplementation(expect: Extract<EvalCase, { stage: "implementation" }>["expect"], outcome: CaseOutcome): Grade {
	const reasons: string[] = [];
	for (const check of outcome.checks ?? []) {
		if (!check.passed) reasons.push(`check failed: ${quote(check.command)}${check.output ? `: ${check.output.slice(-300)}` : ""}`);
	}
	const files = new Set(outcome.changedFiles ?? []);
	for (const file of expect.changedFilesMustInclude ?? []) {
		if (!files.has(file)) reasons.push(`the implementation did not change ${quote(file)}`);
	}
	for (const file of expect.changedFilesMustNotInclude ?? []) {
		if (files.has(file)) reasons.push(`the implementation changed forbidden file ${quote(file)}`);
	}
	const diff = outcome.diff?.toLowerCase() ?? "";
	for (const term of expect.diffMustMention ?? []) {
		if (!diff.includes(term.toLowerCase())) reasons.push(`the implementation diff does not mention ${quote(term)}`);
	}
	return reasons.length === 0 ? pass() : fail(...reasons);
}

function gradeImplementationReview(
	expect: Extract<EvalCase, { stage: "implementation-review" }>["expect"],
	outcome: CaseOutcome,
): Grade {
	const review = outcome.implementationReview;
	if (!review) return fail("the implementation reviewer made no submission");
	const reasons: string[] = [];
	if (review.needsRevision !== expect.needsRevision) {
		reasons.push(`expected needsRevision=${expect.needsRevision}, got ${review.needsRevision}`);
	}
	if (expect.maxIssues !== undefined && review.issues.length > expect.maxIssues) {
		reasons.push(`reported ${review.issues.length} issues; at most ${expect.maxIssues} allowed`);
	}
	reasons.push(...missingFindings(expect.findings ?? [], review.issues.map((issue) => ({ file: issue.file, text: issue.problem }))));
	return reasons.length === 0 ? pass() : fail(...reasons);
}

function gradePrReview(expect: Extract<EvalCase, { stage: "pr-review" }>["expect"], outcome: CaseOutcome): Grade {
	const review = outcome.review;
	if (!review) return fail("the PR reviewer made no submission");
	const reasons: string[] = [];
	if (expect.riskTier && review.riskTier !== expect.riskTier) {
		reasons.push(`expected risk tier ${quote(expect.riskTier)}, got ${quote(review.riskTier)}`);
	}
	if (expect.maxComments !== undefined && review.comments.length > expect.maxComments) {
		reasons.push(`reported ${review.comments.length} comments; at most ${expect.maxComments} allowed`);
	}
	const findings = [
		...review.comments.map((comment) => ({ file: comment.file, text: `${comment.title}\n${comment.body}` })),
		{ text: review.summary },
	];
	reasons.push(...missingFindings(expect.findings ?? [], findings));
	return reasons.length === 0 ? pass() : fail(...reasons);
}

function missingFindings(
	expected: readonly { file?: string; mustMention: readonly string[] }[],
	actual: readonly { file?: string; text: string }[],
): string[] {
	const reasons: string[] = [];
	for (const finding of expected) {
		const found = actual.some(
			(candidate) =>
				(!finding.file || candidate.file === finding.file) &&
				finding.mustMention.every((term) => candidate.text.toLowerCase().includes(term.toLowerCase())),
		);
		if (!found) {
			const where = finding.file ? ` in ${finding.file}` : "";
			reasons.push(`missing finding${where} mentioning ${finding.mustMention.map(quote).join(", ")}`);
		}
	}
	return reasons;
}

export function gradeForbiddenToolArgs(terms: readonly string[], outcome: CaseOutcome): Grade {
	const calls = outcome.outputs.flatMap((output) => output.trace?.toolCalls ?? []);
	const reasons: string[] = [];
	for (const term of terms) {
		const found = calls.find((call) => JSON.stringify(call.args).toLowerCase().includes(term.toLowerCase()));
		if (found) reasons.push(`${found.tool} tool arguments contain ${quote(term)}`);
	}
	return reasons.length === 0 ? pass() : fail(...reasons);
}

/** Every string leaf in a JSON-like value. */
export function strings(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.flatMap(strings);
	if (value && typeof value === "object") return Object.values(value).flatMap(strings);
	return [];
}

const quote = (s: string) => JSON.stringify(s);
