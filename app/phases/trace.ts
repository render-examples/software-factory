import { randomUUID } from "node:crypto";
import type { TaskContext } from "@renderinc/sdk/workflows";

/** The trace is the root task run; local runs without metadata get a random one. */
export function traceIds(ctx: Pick<TaskContext, "metadata">): { traceId: string; runId: string | undefined } {
	const { rootTaskRunId, taskRunId } = ctx.metadata;
	return { traceId: rootTaskRunId ?? taskRunId ?? randomUUID(), runId: taskRunId };
}
