import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tool } from "#factory/sdk";
import { SlackAssistantRenderToolSource } from "../tools/render-read.js";
import { SlackAssistantGitHubToolSource } from "../tools/slack-assistant.js";

beforeEach(() => {
	process.env.FACTORY_REPO = "acme/factory";
	process.env.GITHUB_TOKEN = "github-token";
	process.env.RENDER_API_KEY = "render-key";
	process.env.RENDER_WORKSPACE_ID = "tea-workspace";
});

afterEach(() => {
	vi.unstubAllGlobals();
	delete process.env.FACTORY_REPO;
	delete process.env.GITHUB_TOKEN;
	delete process.env.RENDER_API_KEY;
	delete process.env.RENDER_WORKSPACE_ID;
});

describe("bounded Slack assistant tools", () => {
	it("exposes no repository selector, deploy, or env-value tools", () => {
		const githubTools = new SlackAssistantGitHubToolSource().resolve();
		const renderTools = new SlackAssistantRenderToolSource().resolve();

		for (const tool of githubTools) {
			expect(tool.inputSchema).not.toHaveProperty("owner");
			expect(tool.inputSchema).not.toHaveProperty("repo");
		}
		const renderNames = renderTools.map((tool) => tool.name);
		expect(renderNames).not.toContain("render_trigger_deploy");
		expect(renderNames).not.toContain("render_list_env_vars");
	});

	it("creates an unlabeled issue only in FACTORY_REPO", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					number: 9,
					title: "Draft",
					body: "Details",
					state: "open",
					labels: [],
					user: { login: "factory" },
					html_url: "https://github.test/acme/factory/issues/9",
				}),
				{ status: 201 },
			),
		);
		vi.stubGlobal("fetch", fetchMock);
		const tool = new SlackAssistantGitHubToolSource()
			.resolve()
      .find((candidate) => candidate.name === "draft_factory_issue") as
      | Tool
      | undefined;
		if (!tool) throw new Error("draft tool missing");

		const output = await tool.invoke(
			{ title: "Draft", body: "Details" },
			{ agentId: "assistant" },
		);

		expect(fetchMock.mock.calls[0][0]).toBe(
			"https://api.github.com/repos/acme/factory/issues",
		);
		expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
			title: "Draft",
			body: "Details",
		});
		expect(output.content).toContain("unlabeled issue #9");
	});

	it("keeps Render access read-only and workspace-scoped", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(new Response("[]", { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		const tool = new SlackAssistantRenderToolSource()
			.resolve()
      .find((candidate) => candidate.name === "render_list_services") as
      | Tool
      | undefined;
		if (!tool) throw new Error("list services tool missing");

		await tool.invoke({}, { agentId: "assistant" });

		const url = new URL(fetchMock.mock.calls[0][0]);
		expect(url.pathname).toBe("/v1/services");
		expect(url.searchParams.get("ownerId")).toBe("tea-workspace");
	});
});
