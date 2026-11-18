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
