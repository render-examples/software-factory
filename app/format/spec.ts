import { config } from "../config/index.js";
import type { Spec } from "../contracts/index.js";
import { bullets, codeSpan, fitAround, sanitize, sanitizeInline, truncate } from "./text.js";

/** The rendered spec comment's budget: the caller's marker carries the spec again as JSON, up to SPEC_MAX_JSON_CHARS. */
export const SPEC_BODY_MAX_CHARS = 32_000;

/** The spec's sections as Markdown, with no heading or instructions: for the spec comment and the implementer's message. */
export function renderSpecSections(spec: Spec): string {
	const sections: string[] = [`**${sanitizeInline(spec.title)}**`, sanitize(spec.summary)];
	const section = (heading: string, body: string) => {
		if (body.trim()) sections.push(`### ${heading}\n\n${body}`);
	};
	section("Problem", sanitize(spec.problem));
	section("Goals", bullets(spec.goals));
	section("Non-goals", bullets(spec.nonGoals));
	section(
		"Acceptance criteria",
		spec.acceptanceCriteria.map((c) => `- [ ] **${sanitizeInline(c.id)}**: ${sanitizeInline(c.text)} _(${c.verification})_`).join("\n"),
	);
	section("Approach", sanitize(spec.approach));
	section("Affected areas", spec.affectedAreas.map((a) => `- ${codeSpan(a.path)}: ${sanitizeInline(a.change)}`).join("\n"));
	section("Test plan", sanitize(spec.testPlan));
	section("Risks", bullets(spec.risks));
	section("Assumptions", bullets(spec.assumptions));
	section("Open questions", bullets(spec.openQuestions));
	return sections.join("\n\n");
}

export interface RenderSpecOptions {
	/** Shown in the heading; omit for an unversioned spec. */
	version?: number;
	/** `validateSpec` warnings to show the maintainer. */
	warnings?: readonly string[];
	/** The spec writer's `changeSummary`, shown for a revision. */
	changeSummary?: string;
	/** Set when a revision removed the approval label, so the maintainer knows to reapply it. */
	approvalRemoved?: boolean;
	maxChars?: number;
}

/** The spec comment's visible body. The caller appends the hidden marker that carries the spec as JSON. */
export function renderSpec(spec: Spec, opts: RenderSpecOptions = {}): string {
	const approve = codeSpan(config.labels.specApproved);
	const head = `## Specification${opts.version ? ` v${opts.version}` : ""}\n\n`;

	const extras: string[] = [];
	if (opts.warnings && opts.warnings.length > 0) extras.push(`### Warnings\n\n${truncate(bullets(opts.warnings), 4000)}`);
	if (opts.changeSummary?.trim()) extras.push(`### Changes${opts.version ? ` in v${opts.version}` : ""}\n\n${truncate(sanitize(opts.changeSummary), 4000)}`);
	if (opts.approvalRemoved) extras.push(`> **Note:** the ${approve} label was removed because the spec changed. Reapply it to approve this version.`);
	const tail = [
		"",
		...extras,
		"---",
		`**Next step:** reply to this issue with feedback, or apply the ${approve} label to approve this version.`,
	].join("\n\n");

	return fitAround(head, renderSpecSections(spec), tail, opts.maxChars ?? SPEC_BODY_MAX_CHARS);
}
