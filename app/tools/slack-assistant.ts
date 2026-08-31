import { z } from "zod";
import type { Tool, ToolResult, ToolSource } from "#factory/sdk";
import { factoryRepository } from "../lib/factory-config.js";
import { githubFromEnv } from "../lib/github.js";

const MAX_TOOL_OUTPUT = 100_000;

function result(content: string): ToolResult {
	return {
		content:
			content.length <= MAX_TOOL_OUTPUT
				? content
				: `${content.slice(0, MAX_TOOL_OUTPUT)}\n… [truncated]`,
	};
}

const readFileSchema = {
	path: z.string().min(1).describe("File path within FACTORY_REPO."),
	ref: z.string().optional().describe("Optional branch, tag, or commit SHA."),
};

const readFileTool: Tool<typeof readFileSchema> = {
	name: "repo_read_file",
	description: "Read one UTF-8 file from the configured factory repository.",
	inputSchema: readFileSchema,
	async invoke(input) {
		return result(
			await githubFromEnv().readFile(
				factoryRepository(),
				input.path,
				input.ref,
			),
		);
	},
};

const listDirectorySchema = {
	path: z
		.string()
		.optional()
		.describe("Directory path; omit for repository root."),
	ref: z.string().optional().describe("Optional branch, tag, or commit SHA."),
};

const listDirectoryTool: Tool<typeof listDirectorySchema> = {
	name: "repo_list_directory",
	description: "List a directory in the configured factory repository.",
	inputSchema: listDirectorySchema,
	async invoke(input) {
		const entries = await githubFromEnv().listDirectory(
			factoryRepository(),
			input.path,
			input.ref,
		);
		return result(
			entries
				.map((entry) =>
					entry.type === "dir"
						? `${entry.path}/`
						: `${entry.path} (${entry.size} bytes)`,
				)
				.join("\n") || "(empty directory)",
		);
	},
};

const searchCodeSchema = {
	query: z.string().min(1).max(500).describe("GitHub code-search query."),
	limit: z.number().int().min(1).max(30).optional(),
};

const searchCodeTool: Tool<typeof searchCodeSchema> = {
	name: "repo_search_code",
	description: "Search code only within the configured factory repository.",
	inputSchema: searchCodeSchema,
	async invoke(input) {
		const matches = await githubFromEnv().searchCode(
			factoryRepository(),
			input.query,
			input.limit,
		);
		return result(
			matches.map((match) => `${match.path}\n${match.htmlUrl}`).join("\n\n") ||
				"(no matches)",
		);
	},
};

const draftIssueSchema = {
	title: z.string().min(1).max(200),
	body: z.string().min(1).max(20_000),
};

const draftIssueTool: Tool<typeof draftIssueSchema> = {
	name: "draft_factory_issue",
	description:
		"Create an unlabeled issue in FACTORY_REPO. This does not start the factory; a maintainer must apply FACTORY_LABEL in GitHub.",
	inputSchema: draftIssueSchema,
	async invoke(input) {
		const issue = await githubFromEnv().createIssue(
			factoryRepository(),
			input.title,
			input.body,
		);
		return result(
			`Created unlabeled issue #${issue.number}: ${issue.htmlUrl}\nA maintainer must review it and apply the factory label.`,
		);
	},
};

export class SlackAssistantGitHubToolSource implements ToolSource {
	readonly id = "slack-assistant-github";

	resolve() {
		return [readFileTool, listDirectoryTool, searchCodeTool, draftIssueTool];
	}
}
