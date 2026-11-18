import type { Agent } from "./define.js";
import { implementer } from "./implementer/index.js";
import { prReviewer } from "./pr-reviewer/index.js";
import { specWriter } from "./spec-writer/index.js";
import { triage } from "./triage/index.js";

export const AGENTS: readonly Agent[] = [triage, specWriter, implementer, prReviewer];
