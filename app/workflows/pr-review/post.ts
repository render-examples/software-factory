import type { Review } from "../../schemas/index.js";
import { type RenderReviewOptions, renderReview } from "../../format/index.js";
import { type GitHubClient, GitHubError, parseMarker, type PullRequestReview, renderMarker } from "../../github/index.js";

type ReviewGitHub = Pick<GitHubClient, "botLogin" | "listReviews" | "createReview">;

export async function findReview(gh: ReviewGitHub, pr: number, headSha: string): Promise<PullRequestReview | null> {
	const bot = (await gh.botLogin()).toLowerCase();
	const reviews = await gh.listReviews(pr);
	return reviews.find((r) => r.author.login.toLowerCase() === bot && parseMarker(r.body, "review")?.headSha === headSha) ?? null;
}

export async function postReview(
	gh: ReviewGitHub,
	args: {
		pr: number;
		headSha: string;
		runId: string;
		review: Review;
		render: RenderReviewOptions;
	},
): Promise<{ posted: PullRequestReview; inlineComments: number }> {
	const marker = renderMarker("review", {
		headSha: args.headSha,
		runId: args.runId,
	});
	const post = async (payload: ReturnType<typeof renderReview>) => {
		const posted = await gh.createReview(args.pr, {
			commitId: args.headSha,
			event: payload.event,
			body: `${payload.body}\n\n${marker}`,
			comments: payload.comments,
		});
		return { posted, inlineComments: payload.comments.length };
	};
	const payload = renderReview(args.review, args.render);
	try {
		return await post(payload);
	} catch (error) {
		if (!(error instanceof GitHubError && error.status === 422 && payload.comments.length > 0)) throw error;
		return await post(renderReview(args.review, { ...args.render, isCommentable: () => false }));
	}
}
