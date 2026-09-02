/** Start a Render Workflows task by name. */
export async function dispatchWorkflow(
	taskName: string,
	payload: { issueNumber: number; runId: string },
): Promise<boolean> {
	const slug = process.env.RENDER_WORKFLOW_SLUG;
	if (!slug) {
		console.error(`RENDER_WORKFLOW_SLUG not set — cannot dispatch ${taskName}`);
		return false;
	}

	try {
		const { Render } = await import("@renderinc/sdk");
		await new Render().workflows.startTask(`${slug}/${taskName}`, [payload]);
		return true;
	} catch (error) {
		console.error(`Failed to dispatch ${taskName}:`, error);
		return false;
	}
}
