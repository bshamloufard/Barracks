import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isProcessRunning, unresponsivePiPath } from "../test-support/process-state.js";
import { waitUntil } from "../test-support/wait-until.js";
import { SameUserAgentLauncher } from "./same-user-agent-launcher.js";

let temporaryDirectory: string;

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), "barrack-same-user-launcher-"));
});

afterEach(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
});

describe("SameUserAgentLauncher", () => {
  it("passes the agent's environment through unchanged", async () => {
    const scriptPath = path.join(temporaryDirectory, "print-environment.mjs");
    await writeFile(scriptPath, "process.stdout.write(JSON.stringify(process.env));");

    const { child } = new SameUserAgentLauncher().launch({
      scriptPath,
      scriptArguments: [],
      workingDirectory: temporaryDirectory,
      environment: { HOME: "/home/someone", USER: "someone", PI_OFFLINE: "1" },
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    await new Promise((resolve) => child.once("close", resolve));

    expect(JSON.parse(output)).toMatchObject({
      HOME: "/home/someone",
      USER: "someone",
      PI_OFFLINE: "1",
    });
  });

  it("signals the agent's process and the commands it started in process groups of their own", async () => {
    const commandProcessIdFile = path.join(temporaryDirectory, "command-process-id");
    const launched = new SameUserAgentLauncher().launch({
      scriptPath: unresponsivePiPath,
      scriptArguments: [],
      workingDirectory: temporaryDirectory,
      environment: { PI_STUB_COMMAND_PROCESS_ID_FILE: commandProcessIdFile },
    });
    const commandProcessId = await readProcessIdWhenWritten(commandProcessIdFile);

    await launched.signalAgentProcesses("SIGKILL");

    await waitUntil(() => !isProcessRunning(commandProcessId), "the agent's command has ended");
    await waitUntil(() => launched.child.signalCode !== null, "the agent has ended");
    expect(launched.child.signalCode).toBe("SIGKILL");
  });
});

async function readProcessIdWhenWritten(file: string): Promise<number> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    // The file does not exist until the agent has written it.
    const contents = await readFile(file, "utf8").catch(() => "");
    if (contents.length > 0) {
      return Number(contents);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${file} was never written.`);
}
