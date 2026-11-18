import { randomUUID } from "node:crypto";
import type { TaskContext } from "@renderinc/sdk/workflows";

export function traceIds(ctx: Pick<TaskContext, "metadata">): { traceId: string; runId: string } {
	const { rootTaskRunId, taskRunId } = ctx.metadata;
	const traceId = rootTaskRunId ?? taskRunId ?? randomUUID();
	return { traceId, runId: taskRunId ?? traceId };
}
