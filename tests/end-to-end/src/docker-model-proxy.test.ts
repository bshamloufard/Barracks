import { execFile as execFileCallback, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import {
  type MockModelServer,
  mockModelTriggers,
  startMockModelServer,
} from "@barrack/mock-model-server";
import {
  type AssistantMessageEvent,
  buildThreadModelUsageApiPath,
  modelCatalogueApiPath,
  modelCatalogueSchema,
  modelUsageApiPath,
  ownUsageCapApiPath,
  threadModelUsageResponseSchema,
  userModelUsageResponseSchema,
} from "@barrack/protocol";
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
  stopThread,
  waitUntilSandboxIs,
} from "./support/threads-api.js";

/**
 * Milestone 7's keys out of sandboxes, accepted end to end: two users'
 * threads in containers from the sandbox image, running the real Pi on
 * Anthropic and OpenAI models whose traffic the control plane relays, to
 * the mock model on the host, which records the key each request carried.
 *
 * - Neither user's real key is anywhere the agent can look in its sandbox:
 *   files, environments, process arguments, its own credential file.
 * - Each request reaches the provider with its own thread's owner's key.
 * - A replaced key is used by the next request, nothing in the sandbox
 *   changing; a stopped thread's sandbox token no longer works.
 * - A model switched in the middle of a run lets that run finish.
 * - A cap reached ends the run with a message saying so.
 * - A provider the proxy does not relay still works the old way, its key
 *   in the sandbox, its usage reported, and is labelled so.
 */

const execFile = promisify(execFileCallback);

const dockerTestTimeoutInMilliseconds = 420_000;
const unavailableReason = describeWhyDockerTestCannotRun();
const piAgentDirectory = "/var/lib/barrack/state/pi/agent";

const keys = {
  firstUsersAnthropic: "fake-anthropic-key-of-first-user-0001",
  firstUsersReplacement: "fake-anthropic-key-of-first-user-replaced-0002",
  firstUsersOpenAi: "fake-openai-key-of-first-user-0003",
  firstUsersMock: "first-user-mock-key-in-sandbox-00004",
  secondUsersAnthropic: "fake-anthropic-key-of-second-user-0005",
};

const anthropicModel = "anthropic/claude-haiku-4-5";
const openAiModel = "openai/gpt-4";

function runInSandbox(sandboxId: string, script: string, user?: string): string {
  return execFileSync(
    "docker",
    ["exec", ...(user === undefined ? [] : ["--user", user]), sandboxId, "sh", "-c", script],
    { encoding: "utf8", timeout: 120_000, maxBuffer: 64 * 1024 * 1024 },
  );
}

/**
 * Everything the agent can read in its sandbox that could hold `text`:
 * the name of every file it may read that holds it (grep, given the text
 * on its standard input so that no process's arguments hold it), then
 * whether the environment or arguments of any process it may see do. It
 * takes a while, so it runs without blocking the test's own connections.
 */
async function searchSandboxAsAgent(sandboxId: string, text: string): Promise<string[]> {
  const grep = execFile(
    "docker",
    [
      "exec",
      "--interactive",
      "--user",
      "barrack-agent",
      sandboxId,
      "grep",
      "-rlsF",
      "--exclude-dir=proc",
      "--exclude-dir=sys",
      "--exclude-dir=dev",
      "-f",
      "-",
      "/",
    ],
    { encoding: "utf8", timeout: 300_000, maxBuffer: 16 * 1024 * 1024 },
  );
  grep.child.stdin?.end(`${text}\n`);
  // grep exits 1 when it finds nothing, and execFile then rejects with what it printed.
  const { stdout } = await grep.catch((error: { stdout?: string }) => ({
    stdout: error.stdout ?? "",
  }));
  const holdingFiles = stdout.split("\n").filter((line) => line !== "");
  const processes = runInSandbox(
    sandboxId,
    "cat /proc/[0-9]*/environ /proc/[0-9]*/cmdline 2>/dev/null; true",
    "barrack-agent",
  );
  return processes.includes(text)
    ? [...holdingFiles, "a process's environment or arguments"]
    : holdingFiles;
}

function readAgentsCredentialFile(sandboxId: string): string {
  return runInSandbox(sandboxId, `cat ${piAgentDirectory}/auth.json`, "barrack-agent");
}

function readStartedAt(sandboxId: string): string {
  return execFileSync(
    "docker",
    ["container", "inspect", "--format", "{{.State.StartedAt}}", sandboxId],
    { encoding: "utf8" },
  ).trim();
}

function assistantMessages(client: TestClient): AssistantMessageEvent[] {
  return client
    .threadEvents()
    .flatMap((message) => (message.event.type === "assistant_message" ? [message.event] : []));
}

if (unavailableReason !== undefined) {
  describe.skip(`keys kept out of sandboxes in Docker (skipped: ${unavailableReason})`, () => {
    it("runs", () => {});
  });
} else {
  describe("keys kept out of sandboxes in Docker", () => {
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
        environment: {
          BARRACK_MODEL_PROXY_UPSTREAM_ORIGIN: `development-only:${modelServer.origin}`,
          BARRACK_ALLOW_UNSAFE_MODEL_PROXY_UPSTREAM: "development-only",
        },
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

    async function startThreadOn(model: string, accessToken: string) {
      const userAccess = { ...controlPlane, accessToken };
      const { threadId } = await createThread(userAccess, model);
      threadIds.push(threadId);
      await waitUntilSandboxIs(userAccess, threadId, "running");
      const client = await TestClient.connect(userAccess, threadId, 0);
      clients.push(client);
      await client.waitUntilSupervisorIsConnected();
      return { threadId, sandboxId: findSandboxIdOf(threadId), client, userAccess };
    }

    async function readJson(apiPath: string, accessToken: string): Promise<unknown> {
      const response = await fetch(`${controlPlane.httpBaseUrl}${apiPath}`, {
        headers: { authorization: `Bearer ${accessToken}` },
      });
      return response.json();
    }

    async function setOwnCap(accessToken: string, tokens: number | null): Promise<void> {
      const response = await fetch(`${controlPlane.httpBaseUrl}${ownUsageCapApiPath}`, {
        method: "PUT",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({ tokens }),
      });
      expect(response.status).toBe(200);
    }

    function credentialsOfRequestsMentioning(marker: string): Array<string | undefined> {
      return modelServer.receivedRequests.flatMap((request) =>
        JSON.stringify(request.conversation).includes(marker) ? [request.credential] : [],
      );
    }

    it(
      "keeps each user's key on the server, spends it on their own threads alone, and still runs a provider it does not relay",
      async () => {
        const firstUser = controlPlane.accessToken;
        const secondUser = await controlPlane.signInSecondUser();
        const asFirst = { ...controlPlane, accessToken: firstUser };
        const asSecond = { ...controlPlane, accessToken: secondUser };
        await saveModelCredential(asFirst, "anthropic", keys.firstUsersAnthropic);
        await saveModelCredential(asFirst, "openai", keys.firstUsersOpenAi);
        await saveModelCredential(asSecond, "anthropic", keys.secondUsersAnthropic);
        const first = await startThreadOn(anthropicModel, firstUser);
        const second = await startThreadOn(anthropicModel, secondUser);

        // Each thread's requests carry its own owner's real key.
        first.client.sendUserMessage("Hello from the first user");
        second.client.sendUserMessage("Hello from the second user");
        await first.client.waitUntilRunsHaveSettled(1);
        await second.client.waitUntilRunsHaveSettled(1);
        expect(credentialsOfRequestsMentioning("from the first user")).toEqual([
          keys.firstUsersAnthropic,
        ]);
        expect(credentialsOfRequestsMentioning("from the second user")).toEqual([
          keys.secondUsersAnthropic,
        ]);

        // Neither real key is anywhere the agent can look; its credential
        // file holds a token for the proxy instead.
        for (const sandbox of [first, second]) {
          for (const key of Object.values(keys)) {
            expect(await searchSandboxAsAgent(sandbox.sandboxId, key)).toEqual([]);
          }
        }
        const firstCredentialFile = readAgentsCredentialFile(first.sandboxId);
        const firstToken = JSON.parse(firstCredentialFile).anthropic.key as string;
        expect(firstToken.length).toBeGreaterThanOrEqual(40);
        // The search does find what is there: the token, in the agent's own file.
        expect(await searchSandboxAsAgent(first.sandboxId, firstToken)).toEqual([
          `${piAgentDirectory}/auth.json`,
        ]);
        expect(
          JSON.parse(
            runInSandbox(first.sandboxId, `cat ${piAgentDirectory}/models.json`, "barrack-agent"),
          ).providers.anthropic.baseUrl,
        ).toMatch(new RegExp(`/threads/${first.threadId}/model-proxy/anthropic$`));

        // A replaced key is used by the next request, and nothing in the
        // sandbox changes: not its credential file, not its container.
        const startedAt = readStartedAt(first.sandboxId);
        await saveModelCredential(asFirst, "anthropic", keys.firstUsersReplacement);
        first.client.sendUserMessage("Again from the first user");
        await first.client.waitUntilRunsHaveSettled(2);
        expect(credentialsOfRequestsMentioning("Again from the first user")).toEqual([
          keys.firstUsersReplacement,
        ]);
        expect(readAgentsCredentialFile(first.sandboxId)).toBe(firstCredentialFile);
        expect(readStartedAt(first.sandboxId)).toBe(startedAt);

        // A model switched mid-run lets the run in progress finish on its
        // own model; the next run is on the new one.
        first.client.sendUserMessage(`${mockModelTriggers.command}sleep 3 && echo slept`);
        await first.client.waitUntil("the run's command starts", (messages) =>
          messages.some(
            (message) =>
              message.type === "thread_event" &&
              message.event.type === "tool_execution_started" &&
              JSON.stringify(message.event.arguments).includes("sleep 3"),
          ),
        );
        await changeThreadModel(first.userAccess, first.threadId, openAiModel);
        await first.client.waitUntilRunsHaveSettled(3);
        expect(assistantMessages(first.client).at(-1)).toMatchObject({ endReason: "completed" });
        expect(
          first.client.threadEvents().some((message) => message.event.type === "agent_failed"),
        ).toBe(false);
        expect(modelServer.receivedRequests.at(-1)).toMatchObject({
          format: "anthropic_messages",
          credential: keys.firstUsersReplacement,
        });
        first.client.sendUserMessage("Now on OpenAI, first user");
        await first.client.waitUntilRunsHaveSettled(4);
        expect(modelServer.receivedRequests.at(-1)).toMatchObject({
          format: "openai_responses",
          credential: keys.firstUsersOpenAi,
        });

        // The second user reaches their cap: the run ends saying so, and the
        // next message is refused.
        const secondsUsage = userModelUsageResponseSchema.parse(
          await readJson(modelUsageApiPath, secondUser),
        );
        await setOwnCap(secondUser, secondsUsage.cap.countedTokensInWindow + 1);
        second.client.sendUserMessage(`Please ${mockModelTriggers.toolExecution}`);
        await second.client.waitUntilRunsHaveSettled(2);
        expect(assistantMessages(second.client).at(-1)).toMatchObject({
          endReason: "errored",
          errorKind: "usage_cap_reached",
        });
        second.client.sendUserMessage("Carry on, second user");
        await second.client.waitUntil("the message is refused", (messages) =>
          messages.some(
            (message) =>
              message.type === "client_message_rejected" &&
              message.reason.includes("model usage cap"),
          ),
        );
        await setOwnCap(secondUser, null);

        // Usage was measured at the proxy.
        const firstThreadUsage = threadModelUsageResponseSchema.parse(
          await readJson(buildThreadModelUsageApiPath(first.threadId), firstUser),
        );
        expect(new Set(firstThreadUsage.byModel.map((total) => total.source))).toEqual(
          new Set(["measured"]),
        );

        // Once the thread is stopped, its sandbox's token no longer works.
        await stopThread(first.userAccess, first.threadId);
        await waitUntilSandboxIs(first.userAccess, first.threadId, "stopped");
        const afterStop = await fetch(
          `${controlPlane.httpBaseUrl}/threads/${first.threadId}/model-proxy/anthropic/v1/messages`,
          {
            method: "POST",
            headers: { "x-api-key": firstToken, "content-type": "application/json" },
            body: JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 10, messages: [] }),
          },
        );
        expect(afterStop.status).toBe(403);

        // A provider the proxy does not relay still works the old way: its
        // key is in the sandbox, its usage only reported, and it is labelled so.
        await saveModelCredential(asFirst, "mock", keys.firstUsersMock);
        const old = await startThreadOn("mock/mock-1", firstUser);
        writeFileInSandboxAsAgent(
          old.sandboxId,
          `${piAgentDirectory}/models.json`,
          JSON.stringify({
            providers: {
              mock: {
                baseUrl: `http://host.docker.internal:${modelServer.port}/v1`,
                api: "openai-completions",
                models: [
                  { id: "mock-1", name: "mock-1", contextWindow: 100_000, maxTokens: 4_096 },
                ],
              },
            },
          }),
        );
        old.client.sendUserMessage("Hello the old way");
        await old.client.waitUntilRunsHaveSettled(1);
        expect(credentialsOfRequestsMentioning("Hello the old way")).toEqual([keys.firstUsersMock]);
        expect(readAgentsCredentialFile(old.sandboxId)).toContain(keys.firstUsersMock);
        await expect
          .poll(async () =>
            threadModelUsageResponseSchema
              .parse(await readJson(buildThreadModelUsageApiPath(old.threadId), firstUser))
              .byModel.map((total) => total.source),
          )
          .toEqual(["reported"]);
        const catalogue = modelCatalogueSchema.parse(
          await readJson(modelCatalogueApiPath, firstUser),
        );
        const placementOf = (providerId: string) =>
          catalogue.providers.find((entry) => entry.providerId === providerId)?.keyPlacement;
        expect(placementOf("anthropic")).toBe("kept_on_server");
        expect(placementOf("openai")).toBe("kept_on_server");
        expect(placementOf("google")).toBe("placed_in_sandbox");

        // No key in any event, or in any log but the old way's own sandbox file.
        const supervisorLogs = [first.sandboxId, second.sandboxId, old.sandboxId].map((sandboxId) =>
          execFileSync("docker", ["container", "logs", sandboxId], { encoding: "utf8" }),
        );
        const recorded = [first.client, second.client, old.client].map((client) =>
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
