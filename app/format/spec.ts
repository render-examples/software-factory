import { config } from "../config/index.js";
import type { Spec } from "../schemas/index.js";
import { bullets, codeSpan, fitAround, sanitize, sanitizeInline, truncate } from "./text.js";

const SPEC_BODY_MAX_CHARS = 32_000;

export function renderSpecSections(spec: Spec): string {
	const sections: string[] = [`**${sanitizeInline(spec.title)}**`, sanitize(spec.summary)];
	const section = (heading: string, body: string) => {
		if (body.trim()) sections.push(`### ${heading}\n\n${body}`);
	};
	section("Problem", sanitize(spec.problem));
	section("Goals", bullets(spec.goals));
	section("Non-goals", bullets(spec.nonGoals));
	section("Acceptance criteria", acceptanceChecklist(spec));
	section("Approach", sanitize(spec.approach));
	section("Affected areas", spec.affectedAreas.map((a) => `- ${codeSpan(a.path)}: ${sanitizeInline(a.change)}`).join("\n"));
	section("Test plan", sanitize(spec.testPlan));
	section("Risks", bullets(spec.risks));
	section("Assumptions", bullets(spec.assumptions));
	section("Open questions", bullets(spec.openQuestions));
	return sections.join("\n\n");
}

export function acceptanceChecklist(spec: Spec): string {
	return spec.acceptanceCriteria.map((c) => `- [ ] **${sanitizeInline(c.id)}**: ${sanitizeInline(c.text)} _(${c.verification})_`).join("\n");
}

export interface RenderSpecOptions {
	version?: number;
	warnings?: readonly string[];
	changeSummary?: string;
}

export function renderSpec(spec: Spec, opts: RenderSpecOptions = {}): string {
	const approve = codeSpan(config.labels.specApproved);
	const head = `## Specification${opts.version ? ` v${opts.version}` : ""}\n\n`;

	const extras: string[] = [];
	if (opts.warnings && opts.warnings.length > 0) extras.push(`### Warnings\n\n${truncate(bullets(opts.warnings), 4000)}`);
	if (opts.changeSummary?.trim())
		extras.push(`### Changes${opts.version ? ` in v${opts.version}` : ""}\n\n${truncate(sanitize(opts.changeSummary), 4000)}`);
	const tail = [
		"",
		...extras,
		"---",
		`**Next step:** reply to this issue with feedback, or apply the ${approve} label to approve this version.`,
	].join("\n\n");

	return fitAround(head, renderSpecSections(spec), tail, SPEC_BODY_MAX_CHARS);
}
