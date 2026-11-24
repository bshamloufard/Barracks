import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import type { SandboxStatus } from "../sandbox-provider.js";
import { SandboxImageUnavailableError } from "../sandbox-provider-errors.js";
import {
  describeWhyDockerTestsCannotRun,
  dockerTestImage,
} from "../test-support/docker-test-environment.js";
import type { DockerProviderSettings } from "./docker-create-arguments.js";
import { DockerSandboxProvider } from "./docker-sandbox-provider.js";

/**
 * How a Docker sandbox that cannot work fails, with real containers from
 * the sandbox image: each must end in a state, and words, a user can act
 * on, rather than a sandbox reported running that will never do anything.
 */

const unavailableReason = describeWhyDockerTestsCannotRun();
const testTimeoutInMilliseconds = 120_000;

const settings: DockerProviderSettings = {
  image: dockerTestImage,
  cpuLimit: 1,
  memoryLimitInMebibytes: 512,
  processLimit: 256,
  stopTimeoutInSeconds: 10,
  servicePorts: [],
  dockerExecutable: "docker",
  network: undefined,
};

/** Settings a supervisor would accept, with nothing listening at the control plane's address. */
function workableEnvironment(threadId: string): Record<string, string> {
  return {
    BARRACK_CONTROL_PLANE_URL: "ws://127.0.0.1:9",
    BARRACK_THREAD_ID: threadId,
    BARRACK_AGENT_HARNESS: "fake",
  };
}

const token = { BARRACK_SUPERVISOR_TOKEN: randomBytes(32).toString("hex") };

async function waitUntilSettled(
  provider: DockerSandboxProvider,
  sandboxId: string,
): Promise<SandboxStatus> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const status = await provider.getStatus(sandboxId);
    if (status.state === "failed" || status.state === "stopped") {
      return status;
    }
    await delay(250);
  }
  throw new Error(`Sandbox ${sandboxId} did not stop.`);
}

if (unavailableReason !== undefined) {
  describe.skip(`a Docker sandbox that cannot work (skipped: ${unavailableReason})`, () => {
    it("is not tested here", () => {});
  });
} else {
  describe("a Docker sandbox that cannot work", { timeout: testTimeoutInMilliseconds }, () => {
    const provider = new DockerSandboxProvider(settings);
    const createdSandboxIds: string[] = [];

    afterEach(async () => {
      await Promise.all(createdSandboxIds.splice(0).map((id) => provider.destroy(id)));
    }, testTimeoutInMilliseconds);

    async function createSandbox(
      threadId: string,
      supervisorEnvironment: Record<string, string>,
      supervisorSecrets: Record<string, string>,
    ): Promise<string> {
      const { sandboxId } = await provider.create({
        threadId,
        supervisorEnvironment,
        supervisorSecrets,
      });
      createdSandboxIds.push(sandboxId);
      return sandboxId;
    }

    it("is refused when its image cannot be found, as one the installation's administrator must provide", async () => {
      const missingImage = new DockerSandboxProvider({
        ...settings,
        image: `barrack-sandbox:no-such-image-${randomUUID()}`,
      });

      const creation = missingImage.create({
        threadId: `failure-${randomUUID()}`,
        supervisorEnvironment: workableEnvironment("unused"),
        supervisorSecrets: token,
      });

      await expect(creation).rejects.toThrow(SandboxImageUnavailableError);
    });

    it("is failed, in the supervisor's own words, when the supervisor refuses its configuration", async () => {
      const threadId = `failure-${randomUUID()}`;
      const sandboxId = await createSandbox(
        threadId,
        { ...workableEnvironment(threadId), BARRACK_CONTROL_PLANE_URL: "http://wrong" },
        token,
      );

      expect(await waitUntilSettled(provider, sandboxId)).toEqual({
        state: "failed",
        cause: "supervisor-refused-to-start",
        reason: expect.stringContaining("BARRACK_CONTROL_PLANE_URL: must be a ws:// or wss:// URL"),
      });
    });

    it("is failed, saying so, when the supervisor was handed no token", async () => {
      const threadId = `failure-${randomUUID()}`;
      const sandboxId = await createSandbox(threadId, workableEnvironment(threadId), {});

      expect(await waitUntilSettled(provider, sandboxId)).toEqual({
        state: "failed",
        cause: "supervisor-refused-to-start",
        reason: expect.stringContaining(
          "the sandbox provider did not hand this supervisor its token",
        ),
      });
    });

    it("is failed, saying so, when the agent would share the supervisor's user", async () => {
      const threadId = `failure-${randomUUID()}`;
      const sandboxId = await createSandbox(
        threadId,
        {
          ...workableEnvironment(threadId),
          BARRACK_AGENT_HARNESS: "pi",
          BARRACK_AGENT_USER: "barrack-supervisor",
        },
        token,
      );

      expect(await waitUntilSettled(provider, sandboxId)).toEqual({
        state: "failed",
        cause: "supervisor-refused-to-start",
        reason: expect.stringContaining('"barrack-supervisor" is the user this supervisor runs as'),
      });
    });
  });
}
