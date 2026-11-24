import { randomUUID } from "node:crypto";
import type { ControlPlaneToClientMessage } from "@barrack/protocol";
import { createSandboxProvider } from "@barrack/sandbox-providers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  describeWhyDockerTestCannotRun,
  findDockerBridgeGateway,
  sandboxImage,
} from "./support/docker-environment.js";
import { type RunningControlPlane, startControlPlane } from "./support/local-system.js";
import { TestClient } from "./support/test-client.js";

/**
 * One thread whose sandbox is a real Docker container from the sandbox
 * image, created by the Docker provider, with the real control plane running
 * from its sources on the host. The supervisor inside the container (with
 * the fake agent) must connect out by itself, carry a user's message to the
 * agent and back, and connect again by itself after the sandbox is stopped
 * and started.
 *
 * The control plane listens on the host's address on Docker's default bridge
 * network, which containers reach as host.docker.internal. That address is
 * reachable from the host and its containers only; listening on 0.0.0.0
 * instead would also open this unauthenticated control plane to every
 * machine that can reach the host.
 */

const dockerTestTimeoutInMilliseconds = 120_000;
const unavailableReason = describeWhyDockerTestCannotRun();

function lastSupervisorStatus(messages: readonly ControlPlaneToClientMessage[]) {
  return messages.findLast((message) => message.type === "supervisor_connection_status");
}

function supervisorIs(isConnected: boolean) {
  return (messages: readonly ControlPlaneToClientMessage[]): boolean => {
    const status = lastSupervisorStatus(messages);
    return (
      status?.type === "supervisor_connection_status" &&
      status.isSupervisorConnected === isConnected
    );
  };
}

if (unavailableReason !== undefined) {
  describe.skip(`a thread in a Docker sandbox (skipped: ${unavailableReason})`, () => {
    it("is not tested here", () => {});
  });
} else {
  describe("a thread in a Docker sandbox", { timeout: dockerTestTimeoutInMilliseconds }, () => {
    const threadId = `docker-${randomUUID()}`;
    const provider = createSandboxProvider({
      kind: "docker",
      docker: {
        image: sandboxImage,
        cpuLimit: 1,
        memoryLimitInMebibytes: 512,
        processLimit: 256,
        stopTimeoutInSeconds: 10,
        servicePorts: [],
        dockerExecutable: "docker",
      },
    });
    let controlPlane: RunningControlPlane | undefined;
    let sandboxId: string | undefined;
    let client: TestClient | undefined;

    beforeAll(async () => {
      controlPlane = await startControlPlane(findDockerBridgeGateway());
    }, dockerTestTimeoutInMilliseconds);

    // Runs whether or not the test passed, so no container is left behind.
    afterAll(async () => {
      await client?.close();
      if (sandboxId !== undefined) {
        await provider.destroy(sandboxId);
      }
      await controlPlane?.process.stop();
    }, dockerTestTimeoutInMilliseconds);

    it("relays a message through the sandbox's supervisor, which reconnects by itself after a stop and start", async () => {
      if (controlPlane === undefined) {
        throw new Error("The control plane did not start.");
      }
      const port = new URL(controlPlane.webSocketBaseUrl).port;
      ({ sandboxId } = await provider.create({
        threadId,
        supervisorEnvironment: {
          BARRACK_CONTROL_PLANE_URL: `ws://host.docker.internal:${port}`,
          BARRACK_THREAD_ID: threadId,
          BARRACK_SUPERVISOR_TOKEN: controlPlane.supervisorToken,
          BARRACK_AGENT_HARNESS: "fake",
        },
      }));
      client = await TestClient.connect(controlPlane.webSocketBaseUrl, threadId, 0);

      await client.waitUntil("the sandbox's supervisor has connected", supervisorIs(true));
      client.send({ type: "send_user_message", text: "Hello from the host" });
      await client.waitUntilRunsHaveSettled(1);

      await provider.stop(sandboxId);
      await client.waitUntil("the stopped sandbox's supervisor has gone", supervisorIs(false));
      await provider.start(sandboxId);
      await client.waitUntil("the restarted supervisor has reconnected", supervisorIs(true));
      client.send({ type: "send_user_message", text: "Hello again" });
      await client.waitUntilRunsHaveSettled(2);

      const replies = client
        .threadEvents()
        .filter((message) => message.event.type === "assistant_message")
        .map((message) => message.event);
      expect(replies).toMatchObject([
        { content: [{ type: "text", text: 'You said: "Hello from the host"' }] },
        { content: [{ type: "text", text: 'You said: "Hello again"' }] },
      ]);
      expect(await provider.getStatus(sandboxId)).toEqual({ state: "running" });
    });
  });
}
