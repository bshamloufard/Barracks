import { execFileSync } from "node:child_process";
import {
  type ChatMessage,
  type MockModelServer,
  mockModelTriggers,
  startMockModelServer,
} from "@barrack/mock-model-server";
import type { ControlPlaneToClientMessage, ThreadEvent } from "@barrack/protocol";
import { createSandboxProvider } from "@barrack/sandbox-providers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  describeWhyDockerTestCannotRun,
  findDockerBridgeGateway,
  findSandboxIdOf,
  testDockerSettings,
  writeFileInSandboxAsAgent,
} from "./support/docker-environment.js";
import { type RunningControlPlane, startControlPlane } from "./support/local-system.js";
import { TestClient } from "./support/test-client.js";
import {
  createThread,
  deleteThread,
  requestCreation,
  resumeThread,
  stopThread,
  waitUntilSandboxIs,
  waitUntilThreadIsGone,
} from "./support/threads-api.js";

/**
 * Milestone 3's test: several threads, each in a container of its own from
 * the sandbox image, each running the real Pi against a mock model on the
 * host, through the real control plane.
 *
 * - Three threads are given three unrelated tasks at once, each writing
 *   files in its workspace and running commands, and all three work at the
 *   same moment; each thread's history holds only its own work, each
 *   workspace only its own files, and a fourth thread is refused by the
 *   limit of three running sandboxes.
 * - The three threads are deleted, their containers with them. A new
 *   thread stopped and resumed through the API, and then stopped and woken
 *   by a message, carries on its conversation: the model is sent the
 *   earlier turns each time.
 *
 * The control plane and the mock model listen on the host's address on
 * Docker's default bridge network; see docker-sandbox.test.ts for why.
 */

const dockerTestTimeoutInMilliseconds = 300_000;
const unavailableReason = describeWhyDockerTestCannotRun();
const piAgentDirectory = "/var/lib/barrack/state/pi/agent";

/** Long enough that the three tasks' commands are certainly running at once. */
const taskDurationInSeconds = 6;

const projects = ["alpha", "bravo", "charlie"] as const;

function taskFor(project: string): string {
  const command = [
    `mkdir -p /workspace/${project}`,
    `echo ${project} > /workspace/${project}/owner.txt`,
    `seq 1 3 > /workspace/${project}/numbers-${project}.txt`,
    `sleep ${taskDurationInSeconds}`,
    `ls /workspace/${project}`,
  ].join(" && ");
  return `${mockModelTriggers.command}${command}`;
}

function supervisorIs(isConnected: boolean) {
  return (messages: readonly ControlPlaneToClientMessage[]): boolean => {
    const status = messages.findLast((message) => message.type === "supervisor_connection_status");
    return (
      status?.type === "supervisor_connection_status" &&
      status.isSupervisorConnected === isConnected
    );
  };
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

/** Every file in the sandbox's workspace other than Git's own, read as the agent. */
function listWorkspaceFiles(sandboxId: string): string[] {
  const output = execFileSync(
    "docker",
    [
      "exec",
      "--user",
      "barrack-agent",
      sandboxId,
      ...["find", "/workspace", "-type", "f", "-not", "-path", "/workspace/.git/*"],
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
  return output
    .split("\n")
    .filter((line) => line !== "")
    .sort();
}

function textOf(message: ChatMessage): string {
  return typeof message.content === "string" ? message.content : JSON.stringify(message.content);
}

if (unavailableReason !== undefined) {
  describe.skip(`threads in Docker sandboxes, stopped and resumed (skipped: ${unavailableReason})`, () => {
    it("is not tested here", () => {});
  });
} else {
  describe("threads in Docker sandboxes, stopped and resumed", {
    timeout: dockerTestTimeoutInMilliseconds,
  }, () => {
    const provider = createSandboxProvider({ kind: "docker", docker: testDockerSettings });
    let controlPlane: RunningControlPlane;
    let modelServer: MockModelServer;
    const threadIds: string[] = [];
    const clients: TestClient[] = [];

    beforeAll(async () => {
      const hostAddress = findDockerBridgeGateway();
      modelServer = await startMockModelServer(hostAddress);
      controlPlane = await startControlPlane({
        host: hostAddress,
        sandboxes: { kind: "docker" },
        agent: { harness: "pi", model: "mock/mock-1" },
        environment: { BARRACK_RUNNING_SANDBOXES_PER_USER: "3" },
      });
    }, dockerTestTimeoutInMilliseconds);

    // Runs whether or not the tests passed, so no container is left behind.
    afterAll(async () => {
      await Promise.all(clients.map((client) => client.close()));
      for (const threadId of threadIds) {
        try {
          await provider.destroy(findSandboxIdOf(threadId));
        } catch (error) {
          console.warn(`Could not destroy the sandbox of thread ${threadId}:`, error);
        }
      }
      await modelServer?.close();
      await controlPlane?.stop();
    }, dockerTestTimeoutInMilliseconds);

    /** A thread whose sandbox runs Pi, configured for the mock model, with a client watching. */
    async function startThreadOnPi() {
      const { threadId } = await createThread(controlPlane);
      threadIds.push(threadId);
      await waitUntilSandboxIs(controlPlane, threadId, "running");
      const sandboxId = findSandboxIdOf(threadId);
      const client = await TestClient.connect(controlPlane, threadId, 0);
      clients.push(client);
      await client.waitUntil("the sandbox's supervisor has connected", supervisorIs(true));
      writeFileInSandboxAsAgent(
        sandboxId,
        `${piAgentDirectory}/models.json`,
        describeMockModel(modelServer),
      );
      return { threadId, sandboxId, client };
    }

    it("runs three threads on three tasks at the same moment, none touching another's history or files, and refuses a fourth", async () => {
      const threads = await Promise.all(projects.map(() => startThreadOnPi()));

      const fourth = await requestCreation(controlPlane);
      threads.forEach(({ client }, index) => {
        client.sendUserMessage(taskFor(projects[index] ?? ""));
      });
      await Promise.all(threads.map(({ client }) => client.waitUntilRunsHaveSettled(1)));

      expect(fourth).toMatchObject({
        status: 409,
        errorCode: "sandbox_limit_reached",
        message: expect.stringMatching(/^You already have 3 sandboxes running/),
      });
      const recordedTimes = (eventType: ThreadEvent["type"]) =>
        threads.map(({ client }) => {
          const recorded = client.threadEvents().find(({ event }) => event.type === eventType);
          return new Date(recorded?.recordedAt ?? Number.NaN).getTime();
        });
      const lastCommandStarted = Math.max(...recordedTimes("tool_execution_started"));
      const firstCommandFinished = Math.min(...recordedTimes("tool_execution_finished"));
      expect(lastCommandStarted).toBeLessThan(firstCommandFinished);

      threads.forEach(({ client, sandboxId }, index) => {
        const project = projects[index] ?? "";
        const others = projects.filter((other) => other !== project);
        const history = JSON.stringify(client.threadEvents().map(({ event }) => event));
        const toolOutputs = client
          .threadEvents()
          .flatMap(({ event }) =>
            event.type === "tool_execution_finished" ? [event.output.text] : [],
          );
        expect(toolOutputs).toEqual([`numbers-${project}.txt\nowner.txt\n`]);
        for (const other of others) {
          expect(history).not.toContain(other);
        }
        expect(listWorkspaceFiles(sandboxId)).toEqual([
          `/workspace/${project}/numbers-${project}.txt`,
          `/workspace/${project}/owner.txt`,
        ]);
      });
    });

    it("carries on its conversation after being stopped and resumed, and after being stopped and woken by a message", async () => {
      for (const threadId of threadIds.splice(0)) {
        const sandboxId = findSandboxIdOf(threadId);
        expect((await deleteThread(controlPlane, threadId)).status).toBe(202);
        await waitUntilThreadIsGone(controlPlane, threadId);
        expect(await provider.getStatus(sandboxId)).toEqual({ state: "missing" });
      }
      const { threadId, client } = await startThreadOnPi();
      const conversationsAbout = (codeword: string) =>
        modelServer.receivedConversations.filter((conversation) =>
          conversation.some((message) => textOf(message).includes(codeword)),
        );

      client.sendUserMessage("Remember the codeword PAPAYA.");
      await client.waitUntilRunsHaveSettled(1);
      expect((await stopThread(controlPlane, threadId)).status).toBe(202);
      await waitUntilSandboxIs(controlPlane, threadId, "stopped");
      await client.waitUntil("the stopped sandbox's supervisor has gone", supervisorIs(false));
      expect((await resumeThread(controlPlane, threadId)).status).toBe(202);
      await waitUntilSandboxIs(controlPlane, threadId, "running");
      client.sendUserMessage("What was the codeword? KIWI");
      await client.waitUntilRunsHaveSettled(2);
      const afterResume = conversationsAbout("KIWI").at(-1) ?? [];

      await stopThread(controlPlane, threadId);
      await waitUntilSandboxIs(controlPlane, threadId, "stopped");
      client.sendUserMessage("And once more, please. MANGO");
      await client.waitUntilRunsHaveSettled(3);
      const afterWaking = conversationsAbout("MANGO").at(-1) ?? [];

      const turns = (conversation: ChatMessage[]) =>
        conversation
          .filter((message) => message.role === "user" || message.role === "assistant")
          .map((message) => `${message.role}: ${textOf(message)}`);
      expect(turns(afterResume)).toEqual([
        expect.stringMatching(/^user: .*Remember the codeword PAPAYA/),
        expect.stringMatching(/^assistant: .*Hello there/),
        expect.stringMatching(/^user: .*What was the codeword\? KIWI/),
      ]);
      expect(turns(afterWaking)).toEqual([
        expect.stringMatching(/^user: .*PAPAYA/),
        expect.stringMatching(/^assistant: .*Hello there/),
        expect.stringMatching(/^user: .*KIWI/),
        expect.stringMatching(/^assistant: .*Hello there/),
        expect.stringMatching(/^user: .*MANGO/),
      ]);
    });
  });
}
