import { Render } from "@renderinc/sdk";
import type { TaskContext } from "@renderinc/sdk/workflows";
import { z } from "zod";

const RENDER_API = "https://api.render.com/v1";

let workflowSlug: Promise<string> | undefined;

export async function startTask(ctx: Pick<TaskContext, "metadata">, task: string, input: object, idempotencyKey: string): Promise<{ id: string }> {
	const taskRunId = ctx.metadata.taskRunId;
	if (!taskRunId) throw new Error(`can't start ${task} without this task run's ID`);
	const render = new Render();
	workflowSlug ??= slugOf(render, taskRunId).catch((error) => {
		workflowSlug = undefined;
		throw error;
	});
	const run = await render.workflows.startTask(`${await workflowSlug}/${task}`, [input], { idempotencyKey });
	return { id: run.taskRunId };
}

async function slugOf(render: Render, taskRunId: string): Promise<string> {
	const { taskId } = await render.workflows.getTaskRun(taskRunId);
	const { workflowId } = z.object({ workflowId: z.string().min(1) }).parse(await getJson(`/tasks/${taskId}`));
	return z.object({ slug: z.string().min(1) }).parse(await getJson(`/workflows/${workflowId}`)).slug;
}

async function getJson(path: string): Promise<unknown> {
	const res = await fetch(`${RENDER_API}${path}`, { headers: { authorization: `Bearer ${process.env.RENDER_API_KEY}`, accept: "application/json" } });
	if (!res.ok) throw new Error(`Render API GET ${path} returned ${res.status}`);
	return res.json();
}
