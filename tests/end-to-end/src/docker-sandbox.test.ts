import type { ControlPlaneToClientMessage } from "@barrack/protocol";
import { createSandboxProvider } from "@barrack/sandbox-providers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  describeWhyDockerTestCannotRun,
  findDockerBridgeGateway,
  findSandboxIdOf,
  testDockerSettings,
} from "./support/docker-environment.js";
import { type RunningControlPlane, startControlPlane } from "./support/local-system.js";
import { TestClient } from "./support/test-client.js";
import { createThread, waitUntilSandboxIsReady } from "./support/threads-api.js";

/**
 * One thread created through the real control plane's API, whose sandbox
 * the control plane creates as a real Docker container from the sandbox
 * image, with the control plane running from its sources on the host. The
 * supervisor inside the container (with the fake agent) must connect out by
 * itself with the token it was given, carry a user's message to the agent
 * and back, and connect again by itself after the sandbox is stopped and
 * started. The control plane cannot stop or start sandboxes yet, so the
 * test does that through the provider directly.
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
    const provider = createSandboxProvider({ kind: "docker", docker: testDockerSettings });
    let controlPlane: RunningControlPlane | undefined;
    let sandboxId: string | undefined;
    let client: TestClient | undefined;

    beforeAll(async () => {
      controlPlane = await startControlPlane({
        host: findDockerBridgeGateway(),
        sandboxes: { kind: "docker" },
      });
    }, dockerTestTimeoutInMilliseconds);

    // Runs whether or not the test passed, so no container is left behind.
    afterAll(async () => {
      await client?.close();
      if (sandboxId !== undefined) {
        await provider.destroy(sandboxId);
      }
      await controlPlane?.stop();
    }, dockerTestTimeoutInMilliseconds);

    it("creates the thread's sandbox, whose supervisor relays a message and reconnects by itself after a stop and start", async () => {
      if (controlPlane === undefined) {
        throw new Error("The control plane did not start.");
      }
      const { threadId } = await createThread(controlPlane);
      await waitUntilSandboxIsReady(controlPlane, threadId);
      sandboxId = findSandboxIdOf(threadId);
      client = await TestClient.connect(controlPlane, threadId, 0);

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
