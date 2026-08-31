import { randomUUID } from "node:crypto";
import {
  collectExecOutput,
  shellEscape,
  type Sandbox,
} from "#factory/sdk";

const GITHUB_SEGMENT = /^[A-Za-z0-9_.-]+$/;

export function githubRemoteUrl(owner: string, repo: string): string {
  if (
    !GITHUB_SEGMENT.test(owner) ||
    !GITHUB_SEGMENT.test(repo) ||
    owner === "." ||
    owner === ".." ||
    repo === "." ||
    repo === ".."
  ) {
    throw new Error("GitHub owner and repository must contain only safe characters");
  }
  return `https://github.com/${owner}/${repo}.git`;
}

/**
 * Run one Git network operation without placing the token in the command line
 * or persisting it in the repository's remote URL.
 */
export async function execGitWithToken(
  sandbox: Sandbox,
  token: string,
  args: readonly string[],
): Promise<{ output: string; exitCode: number }> {
  if (args[0] !== "git") {
    throw new Error("execGitWithToken accepts only git commands");
  }
  const askpassPath = `/tmp/render-factory-askpass-${randomUUID()}.sh`;
  const askpassScript = `#!/bin/sh
case "$1" in
  *Username*) printf '%s\\n' 'oauth2' ;;
  *Password*) printf '%s\\n' ${shellEscape(token)} ;;
  *) exit 1 ;;
esac
`;

  await sandbox.upload(askpassPath, askpassScript);
  try {
    const hardenedArgs = [
      "git",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "credential.helper=",
      ...args.slice(1),
    ];
    const command = hardenedArgs.map(shellEscape).join(" ");
    const events = await sandbox.exec(
      `chmod 700 ${shellEscape(askpassPath)} && ` +
        `GIT_ASKPASS=${shellEscape(askpassPath)} GIT_TERMINAL_PROMPT=0 ${command}`,
    );
    return await collectExecOutput(events);
  } finally {
    try {
      const cleanup = await sandbox.exec(`rm -f ${shellEscape(askpassPath)}`);
      await collectExecOutput(cleanup);
    } catch {
      // Sandbox termination is the final cleanup boundary.
    }
  }
}
