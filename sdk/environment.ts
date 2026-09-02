/**
 * Agent execution environment.
 *
 * Environment is workflow-owned context an agent runs *in*, as opposed to the
 * prompt it runs *on*. It crosses the task boundary as plain JSON so it can
 * survive replay, then rehydrates into live capabilities inside agentTask().
 *
 * The model never supplies or selects any part of it.
 */
import type { Sandbox } from "./sandbox/index.js";

/** Where the checked-out repository lives and what revision it is on. */
export interface WorkspaceInfo {
  /** Absolute path to the repository checkout inside the sandbox. */
  readonly repoDir: string;
  /** Fully qualified `owner/repo`, when the workflow targets one. */
  readonly repo?: string;
  readonly branch?: string;
  readonly baseSha?: string;
}

/** Crosses the task boundary; must stay JSON-serializable. */
export interface SerializedEnvironment {
  /** Locator for a workflow-created sandbox, resolved once per agent run. */
  readonly sandbox?: { readonly id: string };
  readonly workspace?: WorkspaceInfo;
}

/** In-process view, after locators have been resolved to live objects. */
export interface Environment {
  readonly sandbox?: Sandbox;
  readonly workspace?: WorkspaceInfo;
}
