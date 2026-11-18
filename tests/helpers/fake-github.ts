import {
	type GitCommit,
	type GitDataClient,
	type GitHubClient,
	GitHubError,
	type IssueComment,
	type LabelEvent,
	type Permission,
	type PullFile,
	type PullRequest,
	type PullRequestReview,
	parseMarker,
	type ReviewComment,
} from "../../app/github/index.js";

export const BOT = "software-factory[bot]";
export const BOT_ID = 4242;

export type FakeComment = IssueComment & { issue: number };
export type FakePull = PullRequest & { draft?: boolean; diff?: string; files?: PullFile[] };
export type FakeReview = PullRequestReview & { pr: number; comments: ReviewComment[] };
type FailingMethod = "createComment" | "updateComment" | "createReview";

const notFound = () => new GitHubError(404, "Not Found");

/** One repository's issues, comments, labels, pull requests, reviews, and branches, as plain state tests seed and inspect. */
export class FakeGitHub {
	comments: FakeComment[] = [];
	labelEvents: Array<LabelEvent & { issue: number }> = [];
	permissions: Record<string, Permission> = { maintainer: "maintain", alice: "write" };
	pulls: FakePull[] = [];
	reviews: FakeReview[] = [];
	refs = new Map<string, string>();
	commits = new Map<string, GitCommit>();
	nextPull = 34;
	private readonly labelSets = new Map<number, Set<string>>();
	private readonly failures: Array<{ method: FailingMethod; error: Error }> = [];
	private nextId = 100;

	labels(issue: number): Set<string> {
		const labels = this.labelSets.get(issue) ?? new Set<string>();
		this.labelSets.set(issue, labels);
		return labels;
	}

	/** Makes the next call to `method` throw `error`. */
	failNext(method: FailingMethod, error: Error = new Error("GitHub is down")): void {
		this.failures.push({ method, error });
	}

	/** Adds a comment by `login`, as if posted at `at`. */
	comment(issue: number, login: string, body: string, at = "2026-10-01T00:00:00Z"): FakeComment {
		const id = this.nextId++;
		const author = { login, type: login.endsWith("[bot]") ? "Bot" : "User" };
		const comment = { id, issue, body, author, createdAt: at, updatedAt: at, htmlUrl: `https://github.test/issues/${issue}#issuecomment-${id}` };
		this.comments.push(comment);
		return { ...comment };
	}

	/** The newest status comment's body. */
	status(): string {
		return this.comments.filter((c) => parseMarker(c.body, "status")).at(-1)?.body ?? "";
	}

	asClient(): GitHubClient {
		return this as unknown as GitHubClient;
	}

	gitData(): GitDataClient {
		const git: Pick<GitDataClient, "getRef" | "getCommit"> = {
			getRef: async (branch) => this.refs.get(branch) ?? null,
			getCommit: async (sha) => {
				const commit = this.commits.get(sha);
				if (!commit) throw notFound();
				return commit;
			},
		};
		return git as GitDataClient;
	}

	botLogin = async () => BOT;
	http = {
		json: async (method: string, path: string) => {
			if (method === "GET" && path === `/users/${encodeURIComponent(BOT)}`) return { id: BOT_ID };
			throw notFound();
		},
	};

	getIssue = async (number: number) => ({
		number,
		title: `Issue #${number}`,
		body: "",
		state: "open",
		labels: [...this.labels(number)],
		author: { login: "reporter", type: "User" },
		isPull: false,
		htmlUrl: `https://github.test/issues/${number}`,
	});
	listIssueComments = async (number: number) => this.comments.filter((c) => c.issue === number).map((c) => ({ ...c }));
	createComment = async (number: number, body: string) => {
		this.fail("createComment");
		return this.comment(number, BOT, body);
	};
	updateComment = async (id: number, body: string) => {
		this.fail("updateComment");
		const comment = this.comments.find((c) => c.id === id);
		if (!comment) throw notFound();
		comment.body = body;
		return { ...comment };
	};
	deleteComment = async (id: number) => {
		this.comments = this.comments.filter((c) => c.id !== id);
	};

	ensureLabel = async () => {};
	addLabels = async (number: number, labels: readonly string[]) => {
		for (const label of labels) this.labels(number).add(label);
	};
	removeLabel = async (number: number, label: string) => {
		this.labels(number).delete(label);
	};
	getLabelEvents = async (number: number, label: string) => this.labelEvents.filter((e) => e.issue === number && e.label === label);
	getPermission = async (login: string) => this.permissions[login] ?? "none";

	getPull = async (number: number) => ({ ...this.pull(number) });
	getPullDiff = async (number: number) => this.pull(number).diff ?? "";
	listPullFiles = async (number: number) => this.pull(number).files ?? [];
	ensurePull = async (args: { head: string; base: string; title: string; body: string; draft?: boolean }) => {
		const number = this.nextPull++;
		const pull: FakePull = {
			number,
			state: "open",
			merged: false,
			title: args.title,
			body: args.body,
			headSha: this.refs.get(args.head) ?? "",
			headRef: args.head,
			baseRef: args.base,
			htmlUrl: `https://github.test/pull/${number}`,
			draft: args.draft ?? true,
		};
		this.pulls.push(pull);
		return { pull: { ...pull }, created: true };
	};

	listReviews = async (pr: number) => this.reviews.filter((r) => r.pr === pr);
	createReview = async (pr: number, review: { commitId: string; body: string; event: "COMMENT"; comments: ReviewComment[] }) => {
		this.fail("createReview");
		const id = this.nextId++;
		const posted: FakeReview = {
			id,
			pr,
			body: review.body,
			comments: review.comments,
			author: { login: BOT, type: "Bot" },
			commitId: review.commitId,
			state: "COMMENTED",
			htmlUrl: `https://github.test/pull/${pr}#pullrequestreview-${id}`,
		};
		this.reviews.push(posted);
		return { ...posted };
	};

	private pull(number: number): FakePull {
		const pull = this.pulls.find((p) => p.number === number);
		if (!pull) throw notFound();
		return pull;
	}

	private fail(method: FailingMethod): void {
		const index = this.failures.findIndex((f) => f.method === method);
		if (index === -1) return;
		const [failure] = this.failures.splice(index, 1);
		throw failure?.error;
	}
}
