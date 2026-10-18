import type { SpecDraft, TriageDecision } from "../../app/contracts/index.js";
import type { EvalCase } from "./case.js";

/** What one case produced. Everything graders read; nothing else. */
export interface CaseOutcome {
	decision?: TriageDecision;
	/** The spec writer's last accepted draft, when triage decided "draft" and the spec passed validation. */
	draft?: SpecDraft;
	/** The spec as the factory would post it (renderSpec). */
	renderedSpec?: string;
	/** Every agent submission, in order, including drafts validation rejected. */
	outputs: Array<{ agentId: string; output: unknown }>;
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
	}
	if (outcome.renderedSpec !== undefined) haystacks.push({ where: "the rendered spec", text: outcome.renderedSpec.toLowerCase() });

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
export function gradeCase(expect: EvalCase["expect"], outcome: CaseOutcome): Grade {
	const grades: Grade[] = [];
	if (outcome.error) grades.push(fail(`stopped early: ${outcome.error}`));
	if (expect.decision) grades.push(gradeDecision(expect.decision, outcome));
	if (expect.specMustMention) grades.push(gradeSpecMentions(expect.specMustMention, outcome));
	if (expect.questionsMax !== undefined) grades.push(gradeQuestionsMax(expect.questionsMax, outcome));
	if (expect.mustNotContain) grades.push(gradeMustNotContain(expect.mustNotContain, outcome));
	if (expect.maxCostUsd !== undefined) grades.push(gradeCost(expect.maxCostUsd, outcome));
	return { pass: grades.every((g) => g.pass), reasons: grades.flatMap((g) => g.reasons) };
}

/** Every string leaf in a JSON-like value. */
export function strings(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.flatMap(strings);
	if (value && typeof value === "object") return Object.values(value).flatMap(strings);
	return [];
}

const quote = (s: string) => JSON.stringify(s);
