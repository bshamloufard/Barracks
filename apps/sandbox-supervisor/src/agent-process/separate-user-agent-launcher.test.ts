import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFakeRunAsAgent } from "../test-support/fake-run-as-agent.js";
import { SeparateUserAgentLauncher } from "./separate-user-agent-launcher.js";
import type { UserAccount } from "./user-account.js";

/**
 * These tests use a stand-in helper that runs the agent as the current user.
 * Signalling the agent's processes is not tested here: it signals every
 * process of the user it runs as, which with the stand-in would be the test
 * runner's own user. The Docker test covers it with the real helper.
 */

const agentAccount: UserAccount = {
  name: "barrack-agent",
  userId: 10002,
  groupId: 10002,
  homeDirectory: "/home/barrack-agent",
  loginShell: "/bin/bash",
};

let temporaryDirectory: string;

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), "barrack-separate-user-launcher-"));
});

afterEach(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
});

describe("SeparateUserAgentLauncher", () => {
  it("starts the agent's script with the supervisor's Node through the helper, naming only the program and its arguments", async () => {
    const { workingHelperPath } = await writeFakeRunAsAgent(temporaryDirectory);
    const scriptPath = path.join(temporaryDirectory, "print-environment.mjs");
    await writeFile(scriptPath, "process.stdout.write(JSON.stringify(process.env));");

    const { child } = new SeparateUserAgentLauncher(agentAccount, workingHelperPath).launch({
      scriptPath,
      scriptArguments: ["--approve"],
      workingDirectory: temporaryDirectory,
      environment: {
        HOME: "/nonexistent",
        USER: "barrack-supervisor",
        LOGNAME: "barrack-supervisor",
        SHELL: "/usr/sbin/nologin",
        PI_OFFLINE: "1",
      },
    });
    const output = await readAll(child.stdout);

    const helperArguments = await readFile(`${workingHelperPath}.arguments`, "utf8");
    expect(helperArguments.trimEnd().split("\n")).toEqual([
      process.execPath,
      scriptPath,
      "--approve",
    ]);
    const agentEnvironment = JSON.parse(output);
    expect(agentEnvironment).toMatchObject({
      HOME: "/home/barrack-agent",
      USER: "barrack-agent",
      LOGNAME: "barrack-agent",
      SHELL: "/bin/bash",
      PI_OFFLINE: "1",
    });
  });

  it("says which user the agent runs as", () => {
    const launcher = new SeparateUserAgentLauncher(agentAccount, "/opt/barrack/bin/run-as-agent");

    expect(launcher.description).toBe('the separate user "barrack-agent"');
  });
});

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  let text = "";
  for await (const chunk of stream) {
    text += String(chunk);
  }
  return text;
}
