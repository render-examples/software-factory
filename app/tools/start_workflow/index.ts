import { defineTool } from "@render-factory/sdk";

const description =
  "Start a background workflow to perform a multi-step task (e.g. research, " +
  "plan, implement, and open a PR). Use this after you have aligned with the " +
  "user on what to build. The workflow runs asynchronously — results will be " +
  "posted back when complete.";

const inputSchema = {
  type: "object",
  properties: {
    workflow: {
      type: "string",
      description: 'The agent/workflow to run. Use "spec-to-pr" to research, plan, implement, and open a PR.',
    },
    spec: {
      type: "object",
      description: "The specification for the work. Include title, description, and repo.",
      properties: {
        title: { type: "string", description: "Short title of the work to do." },
        description: { type: "string", description: "Detailed description of what to implement or fix." },
        repo: {
          type: "object",
          description: "Target GitHub repository (owner + name).",
          properties: { owner: { type: "string" }, repo: { type: "string" } },
          required: ["owner", "repo"],
        },
      },
      required: ["title", "description", "repo"],
    },
  },
  required: ["workflow", "spec"],
} as const;

export default defineTool({
  id: "start_workflow",
  description,
  inputSchema,
  setup(ctx) {
    return {
      id: "start_workflow",
      description,
      inputSchema,
      async invoke(input, toolCtx) {
        const { workflow: name, spec } = (input ?? {}) as {
          workflow?: string;
          spec?: unknown;
        };

        if (!name) return { content: "start_workflow: `workflow` is required", isError: true };
        if (!spec) return { content: "start_workflow: `spec` is required", isError: true };

        const slug = process.env.RENDER_WORKFLOW_SLUG;
        if (!slug) {
          return { content: "start_workflow: RENDER_WORKFLOW_SLUG is not set", isError: true };
        }

        let threadId: string | undefined;
        let userId: string | undefined;
        if (toolCtx.runId) {
          const callingRun = await ctx.store.getRun(toolCtx.runId);
          threadId = callingRun?.threadId;
          userId = callingRun?.userId;
        }

        try {
          const { Render } = await import("@renderinc/sdk");
          const client = new Render();
          const taskSlug = `${slug}/${name}`;
          const run = await client.workflows.startTask(taskSlug, [spec]);
          return `Workflow "${name}" started (task run initiated). Results will be posted back when complete.`;
        } catch (err) {
          return {
            content: `start_workflow: failed to start "${name}": ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }
      },
    };
  },
});
