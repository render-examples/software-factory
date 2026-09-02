/**
 * Git operations inside the sandbox.
 *
 * All of this is workflow-owned. Agents edit files; they never commit, push,
 * or see the GitHub token.
 */
export { execGitWithToken, githubRemoteUrl } from "./auth.js";
export { branchName, setupCheckout } from "./checkout.js";
export { commitChanges, completeDiff } from "./commit.js";
export { verifyPush } from "./push.js";
export { REPO_DIR } from "./run.js";
export type { Checkout, VerificationResult } from "./types.js";
export { runVerification } from "./verify.js";
