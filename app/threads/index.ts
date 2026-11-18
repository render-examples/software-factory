import { z } from "zod";

export type ThreadKey = `${string}:${string}`;

const FORMAT = /^[a-z][a-z0-9-]{0,31}:\S{1,360}$/;

export const ThreadKey = z.custom<ThreadKey>((value) => typeof value === "string" && FORMAT.test(value), "expected a <channel>:<id> thread key");

export interface GitHubThread {
	kind: "issue" | "pr";
	number: number;
}

export function githubThread(repo: string, thread: GitHubThread): ThreadKey {
	return `github:${repo}#${thread.kind}-${thread.number}`;
}

export function parseGitHubThread(repo: string, key: string): GitHubThread | null {
	const match = /^github:(.+)#(issue|pr)-([1-9]\d*)$/.exec(key);
	if (match?.[1] !== repo) return null;
	return { kind: match[2] === "pr" ? "pr" : "issue", number: Number(match[3]) };
}
