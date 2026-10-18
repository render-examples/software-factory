import { AgentError } from "../agents/run.js";

/** The run's dollar budget, passed down to each agent call. Failed calls count too: AgentError carries their cost. */
export class Budget {
	spent = 0;

	constructor(readonly limitUsd: number) {}

	get remaining(): number {
		return Math.max(0, this.limitUsd - this.spent);
	}

	/**
	 * Runs `call` with what the run has left, or with one of `shareOf` equal shares of it, so calls started
	 * together can't spend each other's share. Counts what the call actually spent either way.
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
