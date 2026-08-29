import { defineTool } from "@render-factory/sdk";
import type { WorkflowDefinition } from "@render-factory/sdk";
import type { RunStore } from "@render-factory/store";

let _workflows: Map<string, WorkflowDefinition> | undefined;
let _store: RunStore | undefined;

export default defineTool({
  id: "start_workflow",
  description:
    "Start a background workflow to perform a multi-step task (e.g. research, " +
    "plan, implement, and open a PR). Use this after you have aligned with the " +
    "user on what to build. The workflow runs asynchronously — results will be " +
    "posted back when complete.",
  inputSchema: {
    type: "object",
    properties: {
      workflow: {
        type: "string",
        description:
          'The workflow to run. Use "spec-to-pr" to research, plan, implement, and open a PR.',
      },
      spec: {
        type: "object",
        description:
          "The specification for the work. Include title, description, and repo.",
        properties: {
          title: { type: "string", description: "Short title of the work to do." },
          description: {
            type: "string",
            description: "Detailed description of what to implement or fix.",
          },
          repo: {
            type: "object",
            description: "Target GitHub repository (owner + name).",
            properties: {
              owner: { type: "string" },
              repo: { type: "string" },
            },
            required: ["owner", "repo"],
          },
        },
        required: ["title", "description", "repo"],
      },
    },
    required: ["workflow", "spec"],
  },
  async invoke(input, ctx) {
    const { workflow: name, spec } = (input ?? {}) as {
      workflow?: string;
      spec?: unknown;
    };

    if (!name) return { content: "start_workflow: `workflow` is required", isError: true };
    if (!spec) return { content: "start_workflow: `spec` is required", isError: true };

    if (!_workflows) {
      return {
        content: "start_workflow: workflows not bound yet (server misconfiguration)",
        isError: true,
      };
    }

    const wf = _workflows.get(name);
    if (!wf) {
      const available = [..._workflows.keys()].join(", ");
      return {
        content: `start_workflow: workflow "${name}" not found. Available: ${available || "(none)"}`,
        isError: true,
      };
    }

    let threadId: string | undefined;
    let userId: string | undefined;
    if (_store && ctx.runId) {
      const callingRun = await _store.getRun(ctx.runId);
      threadId = callingRun?.threadId;
      userId = callingRun?.userId;
    }

    const run = await wf.dispatch(spec, "assistant.start_workflow", { threadId, userId });
    return `Workflow "${name}" started (run ${run.id}). Results will be posted back when complete.`;
  },
});
