import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  type MockModelServer,
  mockModelTriggers,
  startMockModelServer,
} from "@barrack/mock-model-server";
import type { ControlPlaneToClientMessage } from "@barrack/protocol";
import { createSandboxProvider } from "@barrack/sandbox-providers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  describeWhyDockerTestCannotRun,
  findDockerBridgeGateway,
  readSandboxExit,
  sandboxImage,
  writeFileInSandboxAsAgent,
} from "./support/docker-environment.js";
import { type RunningControlPlane, startControlPlane } from "./support/local-system.js";
import { TestClient } from "./support/test-client.js";

/**
 * A thread whose sandbox is a real container from the sandbox image, running
 * the real Pi against a mock model on the host. The agent is made to run
 * commands, and everything asserted about what it can reach comes from its
 * own tool output: it runs as its own user, it cannot read the supervisor's
 * environment or files or the token anywhere, cannot signal or trace the
 * supervisor, cannot run the helper that changes user, and can write to its
 * workspace. After a stop and start, its conversation carries on. And when
 * the agent stops Pi from answering, stopping the sandbox still ends Pi and
 * the agent's processes in time, through the helper, since the supervisor
 * may not signal them itself.
 *
 * The control plane and the mock model listen on the host's address on
 * Docker's default bridge network, which containers reach as
 * host.docker.internal; see docker-sandbox.test.ts for why not 0.0.0.0.
 */

const dockerTestTimeoutInMilliseconds = 180_000;
const unavailableReason = describeWhyDockerTestCannotRun();
const probeInSandbox = "/tmp/agent-isolation-probe.mjs";
const piAgentDirectory = "/var/lib/barrack/state/pi/agent";
const agentUserId = 10002;
const supervisorUserId = 10001;
/** The Docker provider's default. */
const stopTimeoutInSeconds = 15;

function supervisorIs(isConnected: boolean) {
  return (messages: readonly ControlPlaneToClientMessage[]): boolean => {
    const status = messages.findLast((message) => message.type === "supervisor_connection_status");
    return (
      status?.type === "supervisor_connection_status" &&
      status.isSupervisorConnected === isConnected
    );
  };
}

function toolOutputs(client: TestClient): string[] {
  return client
    .threadEvents()
    .map((message) => message.event)
    .flatMap((event) => (event.type === "tool_execution_finished" ? [event.output.text] : []));
}

/** Points Pi's `mock` provider at the mock model, which the sandbox reaches on the host. */
function describeMockModel(modelServer: MockModelServer): string {
  const model = { id: "mock-1", name: "Mock 1", contextWindow: 100_000, maxTokens: 4_096 };
  const baseUrl = `http://host.docker.internal:${modelServer.port}/v1`;
  return JSON.stringify({
    providers: {
      mock: { baseUrl, api: "openai-completions", apiKey: "not-a-real-key", models: [model] },
    },
  });
}

if (unavailableReason !== undefined) {
  describe.skip(`the agent in a Docker sandbox (skipped: ${unavailableReason})`, () => {
    it("is not tested here", () => {});
  });
} else {
  describe("the agent in a Docker sandbox", { timeout: dockerTestTimeoutInMilliseconds }, () => {
    const provider = createSandboxProvider({
      kind: "docker",
      docker: {
        image: sandboxImage,
        cpuLimit: 1,
        memoryLimitInMebibytes: 1024,
        processLimit: 256,
        stopTimeoutInSeconds,
        servicePorts: [],
        dockerExecutable: "docker",
      },
    });
    let controlPlane: RunningControlPlane | undefined;
    let modelServer: MockModelServer | undefined;
    const sandboxIds: string[] = [];
    const clients: TestClient[] = [];

    beforeAll(async () => {
      const hostAddress = findDockerBridgeGateway();
      controlPlane = await startControlPlane(hostAddress);
      modelServer = await startMockModelServer(hostAddress);
    }, dockerTestTimeoutInMilliseconds);

    // Runs whether or not the test passed, so no container is left behind.
    afterAll(async () => {
      await Promise.all(clients.map((client) => client.close()));
      await Promise.all(sandboxIds.map((sandboxId) => provider.destroy(sandboxId)));
      await modelServer?.close();
      await controlPlane?.process.stop();
    }, dockerTestTimeoutInMilliseconds);

    /**
     * Creates a thread's sandbox running Pi, and connects a client to the
     * thread. Pi refuses to start until it knows the model, which is
     * configured only once the sandbox exists; the supervisor starts Pi
     * again on the first message, by which time it does.
     */
    async function startThreadOnPi() {
      if (controlPlane === undefined || modelServer === undefined) {
        throw new Error("The control plane or the mock model did not start.");
      }
      const threadId = `docker-agent-${randomUUID()}`;
      const controlPlanePort = new URL(controlPlane.webSocketBaseUrl).port;
      const { sandboxId } = await provider.create({
        threadId,
        supervisorEnvironment: {
          BARRACK_CONTROL_PLANE_URL: `ws://host.docker.internal:${controlPlanePort}`,
          BARRACK_THREAD_ID: threadId,
          BARRACK_SUPERVISOR_TOKEN: controlPlane.supervisorToken,
          BARRACK_MODEL: "mock/mock-1",
          PI_OFFLINE: "1",
        },
      });
      sandboxIds.push(sandboxId);
      const client = await TestClient.connect(controlPlane.webSocketBaseUrl, threadId, 0);
      clients.push(client);
      await client.waitUntil("the sandbox's supervisor has connected", supervisorIs(true));
      writeFileInSandboxAsAgent(
        sandboxId,
        `${piAgentDirectory}/models.json`,
        describeMockModel(modelServer),
      );
      return { sandboxId, client, controlPlanePort, modelServer, controlPlane };
    }

    it("runs Pi as its own user, out of reach of the supervisor's secrets, and resumes its conversation after a stop and start", async () => {
      const { sandboxId, client, controlPlanePort, modelServer, controlPlane } =
        await startThreadOnPi();
      const { supervisorToken } = controlPlane;
      const probe = await readFile(
        new URL("support/agent-isolation-probe.mjs", import.meta.url),
        "utf8",
      );
      writeFileInSandboxAsAgent(sandboxId, probeInSandbox, probe);

      const tokenMiddle = supervisorToken.length / 2;
      const probeCommand = [
        "node",
        probeInSandbox,
        controlPlanePort,
        supervisorToken.slice(0, tokenMiddle),
        supervisorToken.slice(tokenMiddle),
      ].join(" ");
      client.send({
        type: "send_user_message",
        text: `${mockModelTriggers.command}${probeCommand}`,
      });
      await client.waitUntilRunsHaveSettled(1);

      const findings = JSON.parse(toolOutputs(client)[0] ?? "null");
      expect(findings.identity).toEqual({
        user: `${agentUserId}\t${agentUserId}\t${agentUserId}\t${agentUserId}`,
        group: `${agentUserId}\t${agentUserId}\t${agentUserId}\t${agentUserId}`,
        groups: String(agentUserId),
        environment: {
          HOME: "/home/barrack-agent",
          USER: "barrack-agent",
          LOGNAME: "barrack-agent",
          SHELL: "/bin/bash",
        },
        workingDirectory: "/workspace",
      });
      expect(findings.capabilities).toEqual({
        CapInh: "0000000000000000",
        CapPrm: "0000000000000000",
        CapEff: "0000000000000000",
        CapAmb: "0000000000000000",
        NoNewPrivs: "0",
      });
      expect(findings.supervisor).toEqual({
        userId: supervisorUserId,
        readEnvironment: "EACCES",
        listFileDescriptors: "EACCES",
        readMemory: "EACCES",
        signal: "EPERM",
      });
      expect(findings.firstProcess).toEqual({
        userId: supervisorUserId,
        readEnvironment: "EACCES",
        listFileDescriptors: "EACCES",
        readMemory: "EACCES",
        signal: "EPERM",
      });
      expect(findings.runAsAgent).toEqual({ execute: "EACCES", read: "EACCES" });
      expect(findings.supervisorFiles).toEqual({ listRunDirectory: "EACCES", readLog: "EACCES" });
      expect(findings.setuidAndSetgidFiles).toEqual([]);
      expect(findings.token.foundIn).toEqual([]);
      expect(findings.token.readCount).toBeGreaterThan(100);
      expect(findings.controlPlaneConnection).toEqual({
        socketCount: 1,
        heldByAgentProcesses: false,
      });
      expect(findings.supervisorFilesHeldByAgent).toEqual([]);
      // Node connects a child's standard streams through socket pairs (and
      // pipes where it cannot); these are all that cross from the supervisor.
      const supervisorChannel = expect.stringMatching(/^(socket|pipe):\[\d+\]$/);
      expect(findings.piStandardStreams).toEqual([
        { descriptor: 0, target: supervisorChannel },
        { descriptor: 1, target: supervisorChannel },
        { descriptor: 2, target: supervisorChannel },
      ]);
      expect(findings.workspace).toEqual({ write: "allowed", ownerUserId: agentUserId });

      await provider.stop(sandboxId);
      await client.waitUntil("the stopped sandbox's supervisor has gone", supervisorIs(false));
      await provider.start(sandboxId);
      await client.waitUntil("the restarted supervisor has reconnected", supervisorIs(true));
      client.send({
        type: "send_user_message",
        text: `${mockModelTriggers.command}cat /workspace/written-by-the-agent.txt && id -un`,
      });
      await client.waitUntilRunsHaveSettled(2);

      expect(toolOutputs(client)[1]).toBe("written by the agent\nbarrack-agent\n");
      const resumedConversation = JSON.stringify(modelServer.receivedConversations.at(-1));
      expect(resumedConversation).toContain(probeInSandbox);
    });

    it("stops in time when the agent has frozen Pi, ending the agent's processes through the helper", async () => {
      const { sandboxId, client } = await startThreadOnPi();
      // The command leaves behind a process that ignores SIGTERM, in a
      // session of its own, then stops Pi (its shell's parent), which the
      // agent may do since both are its own. Pi then answers nothing, not
      // even the end of its input.
      const freezePi =
        "setsid sh -c 'trap \"\" TERM; sleep 600' > /dev/null 2>&1 < /dev/null & kill -STOP $PPID";
      client.send({ type: "send_user_message", text: `${mockModelTriggers.command}${freezePi}` });
      await client.waitUntil("the agent has started its command", (messages) =>
        messages.some(
          (message) =>
            message.type === "thread_event" && message.event.type === "tool_execution_started",
        ),
      );

      const stopStartedAt = Date.now();
      await provider.stop(sandboxId);
      const stopDurationInMilliseconds = Date.now() - stopStartedAt;

      const sandboxExit = readSandboxExit(sandboxId);
      // Exit code 0 is the supervisor finishing its own stop; Docker killing
      // it at the stop timeout would show as 137.
      expect(sandboxExit.exitCode).toBe(0);
      expect(stopDurationInMilliseconds).toBeLessThan(stopTimeoutInSeconds * 1000);
      expect(sandboxExit.supervisorLogMessages).toEqual(
        expect.arrayContaining([
          "Pi did not exit after its input closed; sending SIGTERM to the agent",
          "Pi did not exit after SIGTERM; sending SIGKILL to the agent",
          "Stopped the supervisor",
        ]),
      );
      expect(sandboxExit.supervisorLogMessages).not.toContain(
        "Signalling the agent's processes failed",
      );
      await client.waitUntilRunsHaveSettled(1);
      expect(client.threadEvents().at(-1)?.event).toEqual({
        type: "agent_run_settled",
        wasInterrupted: true,
      });
    });
  });
}
