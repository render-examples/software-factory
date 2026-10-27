import type { Agent } from "./define.js";
import { implementer } from "./implementer/index.js";
import { prReviewer } from "./pr-reviewer/index.js";
import { specWriter } from "./spec-writer/index.js";
import { triage } from "./triage/index.js";

/**
 * Every agent the factory runs. The sandbox runner is bundled from this list and runs an agent only if it is here.
 * Bundled modules must not import host-only code (GitHub, Sandbox, Workflows, claims, events, config).
 */
export const AGENTS: readonly Agent[] = [triage, specWriter, implementer, prReviewer];
