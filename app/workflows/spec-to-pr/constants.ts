import { factoryConfig } from "../../../factory.config.js";

export const MAX_VERIFY_ROUNDS = factoryConfig.limits.repairRounds;

// The existing pipeline uses this as both the task timeout and the sandbox
// lifetime. It must stay at 24h until later milestones restructure timeouts.
export const SANDBOX_TIMEOUT_SECONDS = 24 * 60 * 60;
