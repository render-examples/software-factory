import { describe, it, expect } from "vitest";
import type { ConnectorSpec, ConnectorContext, WebhookMatch } from "../src/index.js";

describe("@render-agents/gateway", () => {
  it("ConnectorSpec type is assignable", () => {
    const spec: ConnectorSpec = {
      key: "github",
      name: "GitHub",
      handle: async (_req: Request, _ctx: ConnectorContext): Promise<WebhookMatch | null> => {
        return { workflow: "code-review", trigger: "push" };
      },
    };
    expect(spec.key).toBe("github");
  });
});
