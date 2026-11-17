import { z } from "zod";

/**
 * A thread is a channel's unit of conversation that the factory runs work on and records events about, such as a
 * GitHub issue or pull request. Its key is `<channel>:<id>`: a lowercase channel name and an id the channel owns.
 * Only the channel's own code builds or reads the id.
 */
export type ThreadKey = `${string}:${string}`;

const FORMAT = /^[a-z][a-z0-9-]{0,31}:\S{1,360}$/;

export const ThreadKey = z.custom<ThreadKey>((value) => typeof value === "string" && FORMAT.test(value), "expected a <channel>:<id> thread key");

/** A GitHub issue or pull request in a repository the task already knows. */
export interface GitHubThread {
	kind: "issue" | "pr";
	number: number;
}

/** "github:owner/name#issue-12" or "github:owner/name#pr-34". */
export function githubThread(repo: string, thread: GitHubThread): ThreadKey {
	return `github:${repo}#${thread.kind}-${thread.number}`;
}
