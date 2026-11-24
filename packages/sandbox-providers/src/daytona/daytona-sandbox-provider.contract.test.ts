import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { describeSandboxProviderContract } from "../test-support/sandbox-provider-contract.js";
import type { DaytonaApi } from "./daytona-api.js";
import { DaytonaSandboxProvider, sandboxNameFor } from "./daytona-sandbox-provider.js";
import { createDaytonaSdkApi } from "./daytona-sdk-api.js";

/**
 * The contract against Daytona itself. It creates real sandboxes, which
 * costs credit, so it runs only when DAYTONA_API_KEY and
 * BARRACK_DAYTONA_SNAPSHOT (a snapshot made from Barrack's sandbox image)
 * are set. Sandboxes in Daytona cannot reach a server on this machine, so
 * the supervisors are pointed at a closed port, where they keep retrying,
 * and their running is checked inside the sandbox instead.
 */

const {
  DAYTONA_API_KEY: apiKey,
  BARRACK_DAYTONA_SNAPSHOT: snapshot,
  DAYTONA_TARGET: target,
} = process.env;

const supervisorCheckTimeoutInMilliseconds = 60_000;
const supervisorCheckIntervalInMilliseconds = 2_000;
const commandTimeoutInSeconds = 30;

function describeWhyDaytonaCannotBeTested(): string | undefined {
  if (apiKey === undefined || apiKey === "") {
    return "DAYTONA_API_KEY is not set, and Daytona is never called without credentials";
  }
  if (snapshot === undefined || snapshot === "") {
    return "BARRACK_DAYTONA_SNAPSHOT is not set; register the sandbox image as a snapshot first";
  }
  return undefined;
}

async function findSandboxId(daytona: DaytonaApi, threadId: string): Promise<string> {
  const sandbox = await daytona.findSandbox(sandboxNameFor(threadId));
  if (sandbox === undefined) {
    throw new Error(`Thread ${threadId} has no sandbox.`);
  }
  return sandbox.id;
}

/**
 * A launch cannot be counted from outside, but nothing runs in a stopped
 * sandbox, so a supervisor found running after a start was launched by it.
 */
async function waitUntilSupervisorRuns(daytona: DaytonaApi, sandboxId: string): Promise<void> {
  const deadline = Date.now() + supervisorCheckTimeoutInMilliseconds;
  while (Date.now() < deadline) {
    const check = await daytona.executeCommand(
      sandboxId,
      "/usr/local/bin/barrack-ensure-supervisor --check",
      undefined,
      commandTimeoutInSeconds,
    );
    if (check.exitCode === 0) {
      return;
    }
    await delay(supervisorCheckIntervalInMilliseconds);
  }
  throw new Error(`No supervisor is running in sandbox ${sandboxId}.`);
}

async function runInSandbox(daytona: DaytonaApi, sandboxId: string, command: string) {
  const result = await daytona.executeCommand(
    sandboxId,
    command,
    undefined,
    commandTimeoutInSeconds,
  );
  if (result.exitCode !== 0) {
    throw new Error(`"${command}" failed in ${sandboxId} with exit code ${result.exitCode}.`);
  }
  return result.output;
}

describeSandboxProviderContract({
  providerName: "Daytona",
  unavailableReason: describeWhyDaytonaCannotBeTested(),
  async setUp() {
    const daytona = createDaytonaSdkApi(apiKey ?? "");
    const provider = new DaytonaSandboxProvider(
      { snapshot: snapshot ?? "", target, autoArchiveIntervalInMinutes: 60 },
      daytona,
    );
    return {
      provider,
      unknownSandboxId: randomUUID(),
      supervisorEnvironmentFor: (threadId) => ({
        BARRACK_CONTROL_PLANE_URL: "ws://127.0.0.1:9",
        BARRACK_THREAD_ID: threadId,
        BARRACK_SUPERVISOR_TOKEN: randomBytes(32).toString("hex"),
        BARRACK_AGENT_HARNESS: "fake",
      }),
      async waitForSupervisorLaunches(threadId) {
        await waitUntilSupervisorRuns(daytona, await findSandboxId(daytona, threadId));
      },
      async writeFile(sandboxId, path, content) {
        const encoded = Buffer.from(content).toString("base64");
        await runInSandbox(daytona, sandboxId, `sh -c 'echo ${encoded} | base64 -d > ${path}'`);
      },
      readFile: (sandboxId, path) => runInSandbox(daytona, sandboxId, `cat ${path}`),
      async dispose() {},
    };
  },
});
