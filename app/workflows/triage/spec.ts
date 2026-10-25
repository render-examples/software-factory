import { config } from "../../config/index.js";
import { type SpecDraft, validateSpec } from "../../schemas/index.js";
import { renderSpec, sanitizeInline, truncate } from "../../format/index.js";
import { contentHash, type GitHubClient, type Issue, renderMarker } from "../../github/index.js";
import { ExpectedFailure, type Outcome } from "../../claims/index.js";
import type { Sandbox } from "../../sandbox/index.js";
import type { TriageAgents } from "./agents.js";
import { type CurrentSpec, retryMessage } from "./thread.js";

/** The spec a parent task may pass to its next stage. */
export interface TriageHandoff {
	kind: "spec";
	commentId: number;
	hash: string;
	version: number;
}

/** Drafts the spec, and redrafts once if validation rejects it. */
export async function draftSpec(agents: TriageAgents, sandbox: Sandbox, message: string): Promise<{ draft: SpecDraft; warnings: string[] }> {
	const existing = await trackedPaths(sandbox);
	let draft = await agents.specWriter(message);
	let { errors, warnings } = validateSpec(draft.spec, existing);
	if (errors.length > 0) {
		draft = await agents.specWriter(retryMessage(message, draft, errors));
		({ errors, warnings } = validateSpec(draft.spec, existing));
	}
	if (errors.length > 0) {
		throw new ExpectedFailure(truncate(`the spec failed validation twice: ${errors.map(sanitizeInline).join("; ")}`, 1500), "spec_invalid");
	}
	return { draft, warnings };
}

/** Repository-relative paths of every tracked file at the sandbox's checkout. */
async function trackedPaths(sandbox: Sandbox): Promise<Set<string>> {
	const res = await sandbox.exec("git ls-files -z", { asRunner: true });
	if (res.exitCode !== 0) throw new Error(`git ls-files exited ${res.exitCode}: ${res.stderr.trim().slice(-500)}`);
	return new Set(res.stdout.split("\0").filter(Boolean));
}

/**
 * Posts the spec comment, or revises the current one in place with the next version. A spec whose content
 * didn't change leaves the comment untouched, so an approval of it stays valid.
 */
export async function publishSpec(
	gh: Pick<GitHubClient, "createComment" | "updateComment" | "removeLabel">,
	issue: Issue,
	current: CurrentSpec | null,
	{ draft, warnings }: { draft: SpecDraft; warnings: string[] },
): Promise<Outcome<TriageHandoff>> {
	const hash = contentHash(draft.spec);
	if (current && current.hash === hash) {
		return {
			outcome: "unchanged",
			summary: `the spec is unchanged (v${current.version}).`,
			links: [specLink(current.version, current.comment.htmlUrl)],
			data: { kind: "spec", commentId: current.comment.id, hash, version: current.version },
		};
	}
	const version = (current?.version ?? 0) + 1;
	const approvalRemoved = issue.labels.includes(config.labels.specApproved);
	if (approvalRemoved) await gh.removeLabel(issue.number, config.labels.specApproved);

	const visible = renderSpec(draft.spec, { version, warnings, changeSummary: current ? draft.changeSummary : undefined, approvalRemoved });
	const body = `${visible}\n\n${renderMarker("spec", { spec: draft.spec, hash, version, notes: draft.notes })}`;
	const comment = current ? await gh.updateComment(current.comment.id, body) : await gh.createComment(issue.number, body);

	const note = approvalRemoved ? `; \`${config.labels.specApproved}\` was removed, so reapply it to approve this version` : "";
	return {
		outcome: current ? "revised" : "drafted",
		summary: `${current ? "revised the spec to" : "drafted spec"} v${version}${note}.`,
		links: [specLink(version, comment.htmlUrl)],
		data: { kind: "spec", commentId: comment.id, hash, version },
	};
}

const specLink = (version: number, url: string) => ({ label: `Spec v${version}`, url });
