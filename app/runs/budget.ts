import { AgentError } from "../agents/run.js";

/**
 * The run's soft dollar threshold, passed down to each agent call. Failed calls count too.
 * Providers report usage after a response, so actual spend can cross the threshold before the runner stops.
 */
export class Budget {
	spent = 0;

	constructor(readonly limitUsd: number) {}

	get remaining(): number {
		return Math.max(0, this.limitUsd - this.spent);
	}

	/**
	 * Runs `call` with what the run has left, or with one of `shareOf` equal shares of it, so calls started
	 * together limit how much they can overshoot at once. Counts what the call actually spent either way.
	 */
	async track<T extends { costUsd: number }>(call: (budgetUsd: number) => Promise<T>, opts: { shareOf?: number } = {}): Promise<T> {
		try {
			const result = await call(this.remaining / (opts.shareOf ?? 1));
			this.spent += result.costUsd;
			return result;
		} catch (err) {
			if (err instanceof AgentError) this.spent += err.costUsd;
			throw err;
		}
	}
}
