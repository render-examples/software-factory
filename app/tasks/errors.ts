/**
 * Thrown when a run's accumulated cost reaches `limits.perRunUsd`.
 *
 * The error message includes "BUDGET_EXCEEDED" so it can be identified
 * after serialization across a `ctx.run` task boundary (SDK 1.x wraps
 * child task errors in a generic Error, losing the class).
 */
export class BudgetExceededError extends Error {
	readonly code = "BUDGET_EXCEEDED" as const;
	readonly runId: string;
	readonly currentCost: number;
	readonly limit: number;

	constructor(runId: string, currentCost: number, limit: number) {
		super(
			`[BUDGET_EXCEEDED] Run ${runId} has spent $${currentCost.toFixed(4)}, ` +
				`which meets or exceeds the $${limit.toFixed(2)} per-run limit`,
		);
		this.name = "BudgetExceededError";
		this.runId = runId;
		this.currentCost = currentCost;
		this.limit = limit;
	}
}

/**
 * Detect a budget error after it crossed a `ctx.run` boundary. The SDK
 * serializes errors as plain Error objects, so we check the message.
 */
export function isBudgetExceeded(error: unknown): boolean {
	if (error instanceof BudgetExceededError) return true;
	if (error instanceof Error) {
		return error.message.includes("[BUDGET_EXCEEDED]");
	}
	return false;
}
