import type { GitHub, RepoRef } from "../../github/index.js";
import { renderSpecComment } from "../../format/index.js";
import { setSpecCommentId } from "../../store/index.js";
import type { Spec, SpecValidation } from "../../contracts/index.js";

export interface PostSpecCommentInput {
	gh: GitHub;
	repo: RepoRef;
	issueNumber: number;
	specId: string;
	spec: Spec;
	version: number;
	validation: SpecValidation;
	changeSummary?: string;
	approvalRemoved?: boolean;
}

/**
 * Create or edit the spec comment in place using the spec marker.
 * Stores the comment ID on the spec row for future lookups.
 */
export async function postSpecComment(
	input: PostSpecCommentInput,
): Promise<void> {
	const marker = `<!-- render-factory:spec:${input.specId} -->`;

	const body = renderSpecComment({
		spec: input.spec,
		version: input.version,
		validation: input.validation,
		changeSummary: input.changeSummary,
		approvalRemoved: input.approvalRemoved,
	});

	const { id } = await input.gh.upsertMarkedComment(
		input.repo,
		input.issueNumber,
		marker,
		body,
	);

	await setSpecCommentId(input.specId, id);
}
