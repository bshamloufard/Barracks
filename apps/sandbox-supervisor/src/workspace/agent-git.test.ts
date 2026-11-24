import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { SameUserAgentLauncher } from "../agent-process/same-user-agent-launcher.js";
import { AgentGit } from "./agent-git.js";

const { PATH: searchPath } = process.env;

describe("Git run as the agent", () => {
  const git = new AgentGit(new SameUserAgentLauncher(), tmpdir(), {
    PATH: searchPath,
    BARRACK_SUPERVISOR_TOKEN: "never-passed-on",
  });

  it("passes the program's output and exit status through", async () => {
    const outcome = await git.runProgram("sh", ["-c", "echo out; echo err >&2; exit 3"], {
      timeoutInMilliseconds: 10_000,
    });

    expect(outcome).toEqual({ exitCode: 3, standardOutput: "out\n", standardError: "err\n" });
  });

  it("stops a program that runs past its time limit, from the agent's side", async () => {
    const startedAt = Date.now();

    const outcome = await git.runProgram("sleep", ["30"], { timeoutInMilliseconds: 300 });

    expect(outcome.exitCode).toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it("gives the program an environment from an allowlist, never the supervisor's own", async () => {
    const outcome = await git.runProgram("sh", ["-c", "env"], { timeoutInMilliseconds: 10_000 });

    expect(outcome.standardOutput).toContain("GIT_TERMINAL_PROMPT=0");
    expect(outcome.standardOutput).not.toContain("never-passed-on");
  });
});
