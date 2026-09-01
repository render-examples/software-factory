import type {
	ExecutionHandle,
	FactoryStore,
} from "#factory/store";
import { DOWNSTREAM_STAGES, type CheckpointStage } from "./constants.js";

export interface CheckpointAttempt {
	runId: string;
	execution: ExecutionHandle;
	store: FactoryStore;
	refreshSubjectLease: () => Promise<void>;
}

export interface CheckpointRunner {
	run<T>(
		stage: CheckpointStage,
		execute: (context: { generation: number }) => Promise<T>,
	): Promise<T>;
	invalidateDownstream(fromStage: CheckpointStage): Promise<void>;
}

export function createCheckpointRunner(
	attempt: CheckpointAttempt,
): CheckpointRunner {
	return {
		async invalidateDownstream(fromStage: CheckpointStage): Promise<void> {
			const startIndex = DOWNSTREAM_STAGES.indexOf(fromStage.key);
			if (startIndex < 0) return;
			const keys = DOWNSTREAM_STAGES.slice(startIndex);
			if (keys.length === 0) return;
			await attempt.store.runs.invalidateSteps(
				attempt.runId,
				keys,
				"retry_after_fix",
				attempt.execution,
			);
		},

		async run<T>(
			stage: CheckpointStage,
			execute: (context: { generation: number }) => Promise<T>,
		): Promise<T> {
			const state = await attempt.store.runs.beginStep<T>(
				attempt.runId,
				stage.key,
				stage.replaySafe ? "safe" : "guarded",
				attempt.execution,
			);
			if (state.kind === "reuse") {
				await attempt.refreshSubjectLease();
				return state.value;
			}
			if (state.kind === "blocked") {
				throw new Error(
					`Stage "${stage.key}" was interrupted after execution began; refusing non-deterministic replay`,
				);
			}
			if (state.kind === "busy") {
				throw new Error(`Stage "${stage.key}" is already executing`);
			}

			await attempt.refreshSubjectLease();
			try {
				const value = await execute({ generation: state.generation });
				return await attempt.store.runs.completeStep(
					attempt.runId,
					stage.key,
					value,
					attempt.execution,
				);
			} catch (error) {
				await attempt.store.runs
					.failStep(
						attempt.runId,
						stage.key,
						classifyStageError(error),
						attempt.execution,
					)
					.catch(() => {});
				throw error;
			}
		},
	};
}

function classifyStageError(error: unknown): string {
	if (error instanceof Error) {
		if (/lease/i.test(error.message)) return "lease_lost";
		if (/sandbox/i.test(error.message)) return "sandbox_error";
		if (/GitHub/i.test(error.message)) return "github_error";
		if (/invalid structured output/i.test(error.message)) {
			return "invalid_model_output";
		}
	}
	return "stage_error";
}
