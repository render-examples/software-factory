/** TriggerWorkflow — lets agents dispatch workflow tasks via Render SDK. */
import { z } from "zod";
import type { Tool, ToolSource, ToolResult, ToolContext } from "#factory-sdk";

const inputSchema = {
  task: z
    .enum(["spec-to-pr", "pr-review", "pr-fix"])
    .describe("The workflow task to trigger."),
  title: z.string().describe("Short title for the work item."),
  description: z.string().describe("Detailed description of what to implement or review."),
  repo_owner: z.string().describe("GitHub repo owner (e.g. 'render-lab')."),
  repo_name: z.string().describe("GitHub repo name (e.g. 'render-factory')."),
  issue_number: z
    .number()
    .optional()
    .describe("GitHub issue number to link, if applicable."),
};

const triggerWorkflowTool: Tool<typeof inputSchema> = {
  name: "TriggerWorkflow",
  description:
    "Start a workflow task (spec-to-pr, pr-review, pr-fix) to implement code changes, " +
    "review a PR, or fix review feedback. Use this when a user asks for a code change " +
    "that should be implemented in a sandbox and opened as a PR. Returns the task run ID.",
  inputSchema,

  async invoke(input, _ctx: ToolContext): Promise<ToolResult> {
    const slug = process.env.RENDER_WORKFLOW_SLUG;
    if (!slug) {
      return { content: "RENDER_WORKFLOW_SLUG is not set — cannot dispatch workflows.", isError: true };
    }

    const taskInput = {
      title: input.title,
      description: input.description,
      repo: { owner: input.repo_owner, repo: input.repo_name },
      ...(input.issue_number ? { issueNumber: input.issue_number } : {}),
    };

    try {
      const { Render } = await import("@renderinc/sdk");
      const client = new Render();
      const result = await client.workflows.startTask(`${slug}/${input.task}`, [taskInput]);

      return {
        content:
          `Workflow "${input.task}" triggered successfully.\n` +
          `Task: ${input.title}\n` +
          `Repo: ${input.repo_owner}/${input.repo_name}\n` +
          (result ? `Run ID: ${JSON.stringify(result)}` : "Task dispatched."),
      };
    } catch (err) {
      return {
        content: `Failed to trigger workflow: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
};

export class TriggerWorkflowToolSource implements ToolSource {
  readonly id = "trigger-workflow";

  resolve() {
    return [triggerWorkflowTool];
  }
}
