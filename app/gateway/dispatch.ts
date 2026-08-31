/**
 * Shared workflow dispatch for gateway routes.
 *
 * The GitHub gateway sends only a fixed-repository issue number, so dispatch
 * payloads stay small without a second storage protocol.
 */
export type DispatchResult =
  | { ok: true; taskName: string }
  | { ok: false; reason: "no-slug"; taskName: string }
  | { ok: false; reason: "error"; taskName: string; error: unknown };

/**
 * Start a workflow task under the configured workflow slug.
 *
 * @param taskName Bare task name (for this demo, "spec-to-pr").
 * @param payload Single task argument.
 */
export async function dispatchWorkflowTask<T>(
  taskName: string,
  payload: T,
): Promise<DispatchResult> {
  const slug = process.env.RENDER_WORKFLOW_SLUG;
  if (!slug) {
    console.warn(`RENDER_WORKFLOW_SLUG not set — cannot dispatch ${taskName}`);
    return { ok: false, reason: "no-slug", taskName };
  }

  try {
    const { Render } = await import("@renderinc/sdk");
    const client = new Render();
    await client.workflows.startTask(`${slug}/${taskName}`, [payload]);
    return { ok: true, taskName };
  } catch (error) {
    console.error(`Failed to dispatch ${taskName}:`, error);
    return { ok: false, reason: "error", taskName, error };
  }
}
