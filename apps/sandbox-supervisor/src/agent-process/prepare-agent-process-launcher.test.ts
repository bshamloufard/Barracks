import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFakeRunAsAgent } from "../test-support/fake-run-as-agent.js";
import { prepareAgentProcessLauncher } from "./prepare-agent-process-launcher.js";
import { lookUpUserAccount } from "./user-account.js";

/**
 * Users are looked up with `getent`, which Linux has and macOS lacks, so the
 * tests that need another user's account run on Linux only. They use
 * `nobody`, which every Linux system has.
 */
const isLinux = process.platform === "linux";
const otherUserName = "nobody";

let temporaryDirectory: string;
let workspaceDirectory: string;

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), "barrack-prepare-launcher-"));
  workspaceDirectory = path.join(temporaryDirectory, "workspace");
  await mkdir(workspaceDirectory);
});

afterEach(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
});

describe("prepareAgentProcessLauncher", () => {
  it("runs the agent as the supervisor's own user when no agent user is configured", async () => {
    const preparation = await prepareAgentProcessLauncher({
      agentUserName: undefined,
      agentDirectories: [workspaceDirectory],
    });

    expect(preparation).toMatchObject({
      ok: true,
      launcher: { description: "the supervisor's own user" },
    });
  });

  it("runs the agent as the supervisor's own user when that is the configured agent user", async () => {
    const preparation = await prepareAgentProcessLauncher({
      agentUserName: userInfo().username,
      agentDirectories: [workspaceDirectory],
      runAsAgentPath: path.join(temporaryDirectory, "never-needed"),
    });

    expect(preparation).toMatchObject({
      ok: true,
      launcher: { description: "the supervisor's own user" },
    });
  });

  describe.runIf(isLinux)("with an agent user other than the supervisor's", () => {
    it("names an agent user that does not exist", async () => {
      const preparation = await prepareAgentProcessLauncher({
        agentUserName: "barrack-no-such-user",
        agentDirectories: [workspaceDirectory],
      });

      expect(preparation).toEqual({
        ok: false,
        problems: ['BARRACK_AGENT_USER: no user named "barrack-no-such-user" exists'],
      });
    });

    it("names a helper that is missing", async () => {
      const missingHelperPath = path.join(temporaryDirectory, "missing-run-as-agent");

      const preparation = await prepareAgentProcessLauncher({
        agentUserName: otherUserName,
        agentDirectories: [workspaceDirectory],
        runAsAgentPath: missingHelperPath,
      });

      expect(preparation).toEqual({
        ok: false,
        problems: [
          `BARRACK_AGENT_USER: the helper ${missingHelperPath}, which starts the agent as "nobody", is missing or this user may not run it`,
        ],
      });
    });

    it("explains a sandbox in which the helper cannot change user", async () => {
      const { failingHelperPath } = await writeFakeRunAsAgent(temporaryDirectory);

      const preparation = await prepareAgentProcessLauncher({
        agentUserName: otherUserName,
        agentDirectories: [workspaceDirectory],
        runAsAgentPath: failingHelperPath,
      });

      expect(preparation).toEqual({
        ok: false,
        problems: [
          expect.stringContaining(
            "(exit code 127: setpriv: setresuid failed: Operation not permitted). The sandbox must keep the SETUID and SETGID capabilities and must not set no-new-privileges.",
          ),
        ],
      });
    });

    it("names each directory the agent could not write to", async () => {
      const { workingHelperPath } = await writeFakeRunAsAgent(temporaryDirectory);
      const missingDirectory = path.join(temporaryDirectory, "state", "pi", "sessions");

      const preparation = await prepareAgentProcessLauncher({
        agentUserName: otherUserName,
        agentDirectories: [workspaceDirectory, missingDirectory],
        runAsAgentPath: workingHelperPath,
      });

      expect(preparation).toEqual({
        ok: false,
        problems: [`${missingDirectory}: must exist and be writable by the agent's user "nobody"`],
      });
    });

    it("runs the agent as the agent user once the helper has run a process as that user", async () => {
      const { workingHelperPath } = await writeFakeRunAsAgent(temporaryDirectory);
      const lookup = await lookUpUserAccount(otherUserName);
      if (!lookup.found) {
        throw new Error(`This test needs a user named "${otherUserName}".`);
      }

      const preparation = await prepareAgentProcessLauncher({
        agentUserName: otherUserName,
        agentDirectories: [workspaceDirectory],
        runAsAgentPath: workingHelperPath,
      });

      expect(preparation).toMatchObject({
        ok: true,
        launcher: { description: 'the separate user "nobody"' },
      });
      const helperArguments = await readFile(`${workingHelperPath}.arguments`, "utf8");
      expect(helperArguments.split("\n").slice(0, 5)).toEqual([
        `--reuid=${lookup.account.userId}`,
        `--regid=${lookup.account.groupId}`,
        "--init-groups",
        "--",
        process.execPath,
      ]);
    });
  });
});
