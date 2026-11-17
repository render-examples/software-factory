import { randomUUID } from "node:crypto";
import type { TaskContext } from "@renderinc/sdk/workflows";

/** The trace is the root task run; local runs without metadata get a random one, which also serves as the run ID. */
export function traceIds(ctx: Pick<TaskContext, "metadata">): { traceId: string; runId: string } {
	const { rootTaskRunId, taskRunId } = ctx.metadata;
	const traceId = rootTaskRunId ?? taskRunId ?? randomUUID();
	return { traceId, runId: taskRunId ?? traceId };
}
