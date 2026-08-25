import { defineTool } from "@render-factory/sdk";

/**
 * A pretend "deploy" tool — a side-effectful action worth gating behind human
 * approval (see agents/assistant.md `permissions.requireApproval`). With
 * RENDER_FACTORY_STRICT_APPROVAL set, calling this pauses the run for an operator
 * decision in the Approvals view before it actually "runs".
 */
export default defineTool({
  name: "deploy",
  description:
    "Deploy the application to an environment. This performs a real, " +
    "side-effectful release and should be used when the user asks to deploy, " +
    "ship, or release. Requires human approval before it runs.",
  inputSchema: {
    type: "object",
    properties: {
      environment: {
        type: "string",
        enum: ["staging", "production"],
        description: "Target environment to deploy to.",
      },
      service: {
        type: "string",
        description: "Name of the service to deploy.",
      },
    },
    required: ["environment"],
  },
  async invoke(input) {
    const { environment, service } = (input ?? {}) as {
      environment?: string;
      service?: string;
    };
    const target = service ? `${service} to ${environment}` : String(environment);
    return `Deployed ${target}. Release ${Math.random().toString(36).slice(2, 8)} is live.`;
  },
});
