// The Render Workflows service's slug — the address the gateway uses to trigger
// the workflow root (`<slug>/workflow@<plan>`) and the workflow host uses to
// chain reviewer fan-out tasks (`<slug>/agent@<plan>`).
//
// It's defined here in CODE (not required as an env var) because you control the
// service name. In the common case the slug equals the Workflow service's name,
// so keep this in sync with what you name it in the Render Dashboard. If Render
// appends a suffix on a name collision, or you rename the service, either update
// this constant or set RENDER_WORKFLOW_SLUG (env always takes precedence).
export const WORKFLOW_SLUG = "render-agents";

/** Provide the slug default without clobbering an explicit env override. */
export function ensureWorkflowSlug(): void {
  process.env.RENDER_WORKFLOW_SLUG ??= WORKFLOW_SLUG;
}
