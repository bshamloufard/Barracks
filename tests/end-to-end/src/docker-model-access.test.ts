import { execFileSync } from "node:child_process";
import { type MockModelServer, startMockModelServer } from "@barrack/mock-model-server";
import type { AssistantMessageEvent } from "@barrack/protocol";
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
  changeThreadModel,
  createThread,
  saveModelCredential,
  waitUntilSandboxIs,
} from "./support/threads-api.js";

/**
 * Milestone 4's API-key half, accepted end to end: two users, each with
 * keys of their own, each running a thread in a container from the sandbox
 * image, with the real Pi against a mock model on the host that records
 * the key every request presented.
 *
 * - Every request carries its own thread owner's key, never the other's.
 * - Inside a container, nothing started the way a provider's command
 *   interface starts a process (`docker exec`, as the supervisor's user or
 *   the agent's) finds the key in its environment, or in any process's;
 *   the agent can read it from its own credential file, as it must to use it.
 * - A replaced key is used by the next run, in the same container.
 * - A thread switched to another provider's model carries on: the new
 *   model is sent the earlier turns.
 * - An exhausted quota ends the run with a message saying so, and the
 *   thread carries on once switched to another model.
 * - No key appears in any thread event, or in the control plane's or the
 *   supervisors' logs.
 */

const dockerTestTimeoutInMilliseconds = 300_000;
const unavailableReason = describeWhyDockerTestCannotRun();
const piAgentDirectory = "/var/lib/barrack/state/pi/agent";

const keys = {
  firstUsersMock: "first-user-mock-key-0001",
  firstUsersBackup: "first-user-backup-key-0002",
  secondUsersMock: "second-user-mock-key-0003",
  firstUsersReplacement: "first-user-mock-key-replaced-0004",
};

/** Two providers on the mock, each with a model of its own and no key: keys come from users. */
function describeMockModels(modelServer: MockModelServer): string {
  const baseUrl = `http://host.docker.internal:${modelServer.port}/v1`;
  const describeModel = (id: string) => ({
    id,
    name: id,
    contextWindow: 100_000,
    maxTokens: 4_096,
  });
  return JSON.stringify({
    providers: {
      mock: { baseUrl, api: "openai-completions", models: [describeModel("mock-1")] },
      backup: { baseUrl, api: "openai-completions", models: [describeModel("backup-1")] },
    },
  });
}

/** Runs a shell command in the sandbox as `docker exec` does, as the image's default user unless told. */
function runInSandbox(sandboxId: string, script: string, user?: string): string {
  return execFileSync(
    "docker",
    ["exec", ...(user === undefined ? [] : ["--user", user]), sandboxId, "sh", "-c", script],
    { encoding: "utf8", timeout: 30_000 },
  );
}

function readStartedAt(sandboxId: string): string {
  return execFileSync(
    "docker",
    ["container", "inspect", "--format", "{{.State.StartedAt}}", sandboxId],
    {
      encoding: "utf8",
      timeout: 30_000,
    },
  ).trim();
}

function lastAssistantMessage(client: TestClient): AssistantMessageEvent | undefined {
  return client
    .threadEvents()
    .flatMap((message) => (message.event.type === "assistant_message" ? [message.event] : []))
    .at(-1);
}

if (unavailableReason !== undefined) {
  describe.skip(`each user's own model access in Docker (skipped: ${unavailableReason})`, () => {
    it("runs", () => {});
  });
} else {
  describe("each user's own model access in Docker", () => {
    const provider = createSandboxProvider({ kind: "docker", docker: testDockerSettings });
    const threadIds: string[] = [];
    const clients: TestClient[] = [];
    let modelServer: MockModelServer;
    let controlPlane: RunningControlPlane;

    beforeAll(async () => {
      const hostAddress = findDockerBridgeGateway();
      modelServer = await startMockModelServer(hostAddress);
      controlPlane = await startControlPlane({
        host: hostAddress,
        sandboxes: { kind: "docker" },
        agent: { harness: "pi" },
      });
    }, dockerTestTimeoutInMilliseconds);

    // Runs whether or not the test passed, so no container is left behind.
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

    /** A thread of the user `access` signs in as, on the mock model, with a client watching. */
    async function startThreadOnMock(access: { accessToken: string }) {
      const userAccess = { ...controlPlane, accessToken: access.accessToken };
      const { threadId } = await createThread(userAccess, "mock/mock-1");
      threadIds.push(threadId);
      await waitUntilSandboxIs(userAccess, threadId, "running");
      const sandboxId = findSandboxIdOf(threadId);
      const client = await TestClient.connect(userAccess, threadId, 0);
      clients.push(client);
      await client.waitUntilSupervisorIsConnected();
      writeFileInSandboxAsAgent(
        sandboxId,
        `${piAgentDirectory}/models.json`,
        describeMockModels(modelServer),
      );
      return { threadId, sandboxId, client, userAccess };
    }

    /** The key each request whose conversation mentions `marker` presented. */
    function credentialsOfRequestsMentioning(marker: string): Array<string | undefined> {
      return modelServer.receivedConversations.flatMap((conversation, index) =>
        JSON.stringify(conversation).includes(marker)
          ? [modelServer.receivedCredentials[index]]
          : [],
      );
    }

    it(
      "runs each user's thread on that user's own key alone, out of the sandbox's environment, and carries on through a new key, a new model and an exhausted quota",
      async () => {
        const firstUser = { accessToken: controlPlane.accessToken };
        const secondUser = { accessToken: await controlPlane.signInSecondUser() };
        await saveModelCredential({ ...controlPlane, ...firstUser }, "mock", keys.firstUsersMock);
        await saveModelCredential(
          { ...controlPlane, ...firstUser },
          "backup",
          keys.firstUsersBackup,
        );
        await saveModelCredential({ ...controlPlane, ...secondUser }, "mock", keys.secondUsersMock);
        const first = await startThreadOnMock(firstUser);
        const second = await startThreadOnMock(secondUser);

        // Each thread runs on its own owner's key.
        first.client.sendUserMessage("Hello from the first user");
        second.client.sendUserMessage("Hello from the second user");
        await first.client.waitUntilRunsHaveSettled(1);
        await second.client.waitUntilRunsHaveSettled(1);
        expect(credentialsOfRequestsMentioning("from the first user")).toEqual([
          keys.firstUsersMock,
        ]);
        expect(credentialsOfRequestsMentioning("from the second user")).toEqual([
          keys.secondUsersMock,
        ]);

        // Nothing started in the sandbox from outside has the key in its
        // environment, and no process's environment holds it, whichever user
        // looks; the agent's own credential file does, for the agent alone.
        const readEveryEnvironment = "cat /proc/[0-9]*/environ 2>/dev/null | tr '\\0' '\\n'";
        for (const user of [undefined, "barrack-agent"]) {
          const environment = runInSandbox(first.sandboxId, "env", user);
          expect(environment).toContain("BARRACK_THREAD_ID=");
          expect(environment).not.toContain(keys.firstUsersMock);
        }
        // As the supervisor's user, every process of that user, the supervisor
        // among them; as the agent's, every process of the agent, Pi among them.
        const supervisorsEnvironments = runInSandbox(first.sandboxId, readEveryEnvironment);
        const agentsEnvironments = runInSandbox(
          first.sandboxId,
          readEveryEnvironment,
          "barrack-agent",
        );
        expect(supervisorsEnvironments).toContain("BARRACK_SUPERVISOR_STATE_DIRECTORY=");
        expect(agentsEnvironments).toContain("PI_CODING_AGENT_DIR=");
        expect(supervisorsEnvironments).not.toContain(keys.firstUsersMock);
        expect(agentsEnvironments).not.toContain(keys.firstUsersMock);
        expect(
          runInSandbox(first.sandboxId, `cat ${piAgentDirectory}/auth.json`, "barrack-agent"),
        ).toContain(keys.firstUsersMock);
        expect(() =>
          runInSandbox(first.sandboxId, `cat ${piAgentDirectory}/auth.json 2>&1`),
        ).toThrow();
        const configuredEnvironment = execFileSync(
          "docker",
          ["container", "inspect", "--format", "{{json .Config.Env}}", first.sandboxId],
          { encoding: "utf8" },
        );
        expect(configuredEnvironment).not.toContain(keys.firstUsersMock);

        // A replaced key is used by the next run, in the same container.
        const startedAt = readStartedAt(first.sandboxId);
        await saveModelCredential(
          { ...controlPlane, ...firstUser },
          "mock",
          keys.firstUsersReplacement,
        );
        first.client.sendUserMessage("Again from the first user");
        await first.client.waitUntilRunsHaveSettled(2);
        expect(credentialsOfRequestsMentioning("Again from the first user")).toEqual([
          keys.firstUsersReplacement,
        ]);
        expect(findSandboxIdOf(first.threadId)).toBe(first.sandboxId);
        expect(readStartedAt(first.sandboxId)).toBe(startedAt);

        // Another provider's model carries the conversation on.
        await changeThreadModel(first.userAccess, first.threadId, "backup/backup-1");
        first.client.sendUserMessage("Which words did the first user say before?");
        await first.client.waitUntilRunsHaveSettled(3);
        const switchedRequest = modelServer.receivedConversations.length - 1;
        expect(modelServer.receivedModels[switchedRequest]).toBe("backup-1");
        expect(modelServer.receivedCredentials[switchedRequest]).toBe(keys.firstUsersBackup);
        expect(JSON.stringify(modelServer.receivedConversations[switchedRequest])).toContain(
          "Hello from the first user",
        );

        // An exhausted quota ends the run saying so; another model carries on.
        modelServer.exhaustQuotaOf(keys.firstUsersBackup);
        first.client.sendUserMessage("More work from the first user");
        await first.client.waitUntilRunsHaveSettled(4);
        expect(lastAssistantMessage(first.client)).toMatchObject({
          endReason: "errored",
          errorKind: "quota_exhausted",
        });
        await changeThreadModel(first.userAccess, first.threadId, "mock/mock-1");
        first.client.sendUserMessage("Carry on, first user");
        await first.client.waitUntilRunsHaveSettled(5);
        expect(lastAssistantMessage(first.client)).toMatchObject({ endReason: "completed" });
        const recoveredRequest = modelServer.receivedConversations.length - 1;
        expect(modelServer.receivedCredentials[recoveredRequest]).toBe(keys.firstUsersReplacement);
        expect(JSON.stringify(modelServer.receivedConversations[recoveredRequest])).toContain(
          "More work from the first user",
        );

        // The second user's key never left their own thread.
        expect(
          modelServer.receivedCredentials.filter(
            (credential) => credential === keys.secondUsersMock,
          ),
        ).toHaveLength(credentialsOfRequestsMentioning("from the second user").length);

        // No key in any event, or in any log.
        const supervisorLogs = [first.sandboxId, second.sandboxId].map((sandboxId) =>
          execFileSync("docker", ["container", "logs", sandboxId], { encoding: "utf8" }),
        );
        const recorded = [first.client, second.client].map((client) =>
          JSON.stringify(client.threadEvents()),
        );
        for (const text of [
          ...recorded,
          ...supervisorLogs,
          controlPlane.process.describeOutput(),
        ]) {
          for (const key of Object.values(keys)) {
            expect(text).not.toContain(key);
          }
        }
      },
      dockerTestTimeoutInMilliseconds,
    );
  });
}
