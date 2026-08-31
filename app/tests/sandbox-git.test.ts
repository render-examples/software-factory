import { describe, expect, it } from "vitest";
import { execGitWithToken, githubRemoteUrl } from "../lib/sandbox-git.js";
import { shellEscape, type Sandbox, type SandboxExecEvent } from "#factory/sdk";

async function* successfulExec(): AsyncGenerator<SandboxExecEvent> {
  yield { type: "exit", exitCode: 0 };
}

describe("sandbox Git credentials", () => {
  it("validates repository path segments", () => {
    expect(githubRemoteUrl("render-lab", "render_factory.js")).toBe(
      "https://github.com/render-lab/render_factory.js.git",
    );
    expect(() => githubRemoteUrl("render-lab;rm -rf /", "repo")).toThrow(
      /safe characters/,
    );
    expect(() => githubRemoteUrl("owner", "../repo")).toThrow(
      /safe characters/,
    );
    expect(() => githubRemoteUrl("..", "repo")).toThrow(/safe characters/);
  });

  it("keeps the token out of the Git command line", async () => {
    const commands: string[] = [];
    const uploads: Array<{ path: string; content: string }> = [];
    const sandbox = {
      id: "sandbox-1",
      async upload(path: string, data: string) {
        uploads.push({ path, content: data });
      },
      async exec(command: string) {
        commands.push(command);
        return successfulExec();
      },
    } as unknown as Sandbox;

    await execGitWithToken(sandbox, "github_pat_secret", [
      "git",
      "fetch",
      "origin",
    ]);

    expect(commands[0]).toContain("GIT_ASKPASS=");
    expect(commands[0]).not.toContain("github_pat_secret");
    expect(commands[0]).toContain("core.hooksPath=/dev/null");
    expect(commands[0]).toContain("credential.helper=");
    expect(commands[1]).toMatch(/^rm -f /);
    expect(uploads[0].content).toContain("github_pat_secret");
  });

  it("refuses non-git commands", async () => {
    await expect(
      execGitWithToken({} as Sandbox, "token", ["sh", "-c", "env"]),
    ).rejects.toThrow(/only git/);
  });

  it("shell-escapes command substitution and embedded quotes", () => {
    expect(shellEscape("$(touch /tmp/pwned)")).toBe(
      "'$(touch /tmp/pwned)'",
    );
    expect(shellEscape("it's safe")).toBe("'it'\\''s safe'");
  });
});
