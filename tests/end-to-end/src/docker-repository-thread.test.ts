import { execFileSync } from "node:child_process";
import { FakeGithub, type FakeRepository, readAuthor } from "@barrack/fake-github";
import {
  type MockModelServer,
  mockModelTriggers,
  startMockModelServer,
} from "@barrack/mock-model-server";
import { type ThreadEvent, workBranchFor } from "@barrack/protocol";
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
import {
  connectGithub,
  createThreadOnRepository,
  publishThread,
} from "./support/repositories-api.js";
import { TestClient } from "./support/test-client.js";
import { stopThread, waitUntilSandboxIs } from "./support/threads-api.js";

/**
 * Milestone 3's Git test: a thread on a private repository served by the
 * fake GitHub, in a container from the sandbox image, with the real Pi as
 * its own user against the mock model, through the real control plane.
 *
 * The agent's own commands see the cloned files and commit on the thread's
 * branch as the user; from its shell it can fetch, but a push, with the
 * token it can get from the credential helper, is refused. The user
 * publishes: the branch appears with the agent's commit, and exactly one
 * pull request is opened. The thread is stopped, woken by a message, and
 * commits again without cloning again; publishing again moves the branch
 * and opens no second pull request. No token is anywhere it could be read
 * back.
 *
 * Every server listens on the host's address on Docker's default bridge,
 * which the sandbox reaches; see docker-sandbox.test.ts.
 */

const dockerTestTimeoutInMilliseconds = 300_000;
const unavailableReason = describeWhyDockerTestCannotRun();
const piAgentDirectory = "/var/lib/barrack/state/pi/agent";

function describeMockModel(modelServer: MockModelServer): string {
  const model = { id: "mock-1", name: "Mock 1", contextWindow: 100_000, maxTokens: 4_096 };
  const baseUrl = `http://host.docker.internal:${modelServer.port}/v1`;
  return JSON.stringify({
    providers: {
      mock: { baseUrl, api: "openai-completions", apiKey: "not-a-real-key", models: [model] },
    },
  });
}

function eventsOf(client: TestClient): ThreadEvent[] {
  return client.threadEvents().map(({ event }) => event);
}

function countOf(client: TestClient, type: ThreadEvent["type"]): number {
  return eventsOf(client).filter((event) => event.type === type).length;
}

/** The output of the last command the agent ran. */
function lastToolOutput(client: TestClient): string {
  const finished = eventsOf(client).findLast((event) => event.type === "tool_execution_finished");
  return finished?.type === "tool_execution_finished" ? finished.output.text : "";
}

function readAsAgent(sandboxId: string, command: string): string {
  return execFileSync(
    "docker",
    ["exec", "--user", "barrack-agent", sandboxId, "sh", "-c", command],
    { encoding: "utf8", timeout: 30_000 },
  );
}

if (unavailableReason !== undefined) {
  describe.skip(`a thread on a repository in a Docker sandbox (skipped: ${unavailableReason})`, () => {
    it("is not tested here", () => {});
  });
} else {
  describe("a thread on a repository in a Docker sandbox", {
    timeout: dockerTestTimeoutInMilliseconds,
  }, () => {
    const provider = createSandboxProvider({ kind: "docker", docker: testDockerSettings });
    let github: FakeGithub;
    let repository: FakeRepository;
    let modelServer: MockModelServer;
    let controlPlane: RunningControlPlane;
    let client: TestClient | undefined;
    let threadId: string | undefined;

    beforeAll(async () => {
      const hostAddress = findDockerBridgeGateway();
      github = await FakeGithub.start({ host: hostAddress });
      repository = await github.createRepository({
        owner: "octo",
        name: "service",
        isPrivate: true,
        files: { "README.md": "# Service\n", "service.txt": "the private service\n" },
      });
      github.addUser({ login: "octocat", name: "Octo Cat", push: [repository] });
      github.installApp([repository]);
      modelServer = await startMockModelServer(hostAddress);
      controlPlane = await startControlPlane({
        host: hostAddress,
        sandboxes: { kind: "docker" },
        agent: { harness: "pi", model: "mock/mock-1" },
        environment: github.controlPlaneEnvironment(),
      });
    }, dockerTestTimeoutInMilliseconds);

    // Runs whether or not the test passed, so no container is left behind.
    afterAll(async () => {
      await client?.close();
      if (threadId !== undefined) {
        try {
          await provider.destroy(findSandboxIdOf(threadId));
        } catch (error) {
          console.warn(`Could not destroy the sandbox of thread ${threadId}:`, error);
        }
      }
      await modelServer?.close();
      await controlPlane?.stop();
      await github?.close();
    }, dockerTestTimeoutInMilliseconds);

    it("clones, commits as the user, cannot push, is published with one pull request, and carries on after a stop", async () => {
      await connectGithub(controlPlane, github, "octocat");
      const thread = await createThreadOnRepository(controlPlane, {
        url: repository.cloneUrl,
        access: "github_app",
      });
      threadId = thread.threadId;
      const workBranch = workBranchFor(thread.threadId);
      await waitUntilSandboxIs(controlPlane, thread.threadId, "running");
      const sandboxId = findSandboxIdOf(thread.threadId);
      client = await TestClient.connect(controlPlane, thread.threadId, 0);
      await client.waitUntil(
        "the clone",
        () => countOf(client as TestClient, "repository_cloned") === 1,
      );
      writeFileInSandboxAsAgent(
        sandboxId,
        `${piAgentDirectory}/models.json`,
        describeMockModel(modelServer),
      );

      const firstTask = [
        "cd /workspace",
        "cat service.txt",
        "git status --short --branch",
        "echo 'made by the agent' > agent.txt",
        "git add agent.txt",
        "git commit --quiet --message 'Agent change'",
        "git log -1 --format='AUTHOR %an <%ae>'",
        "git fetch --quiet origin && echo FETCHED",
        "git credential fill <<'EOF' | grep -c '^password='\nprotocol=http\nhost=" +
          new URL(repository.cloneUrl).host +
          "\npath=octo/service.git\n\nEOF",
        `git push --quiet origin HEAD:refs/heads/${workBranch} 2>&1; echo "PUSH_EXIT=$?"`,
      ].join("\n");
      client.sendUserMessage(`${mockModelTriggers.command}${firstTask}`);
      await client.waitUntilRunsHaveSettled(1);

      const firstOutput = lastToolOutput(client);
      expect(firstOutput).toContain("the private service");
      expect(firstOutput).toContain(`## ${workBranch}`);
      expect(firstOutput).toMatch(/AUTHOR Octo Cat <\d+\+octocat@users\.noreply\.github\.com>/);
      expect(firstOutput).toContain("FETCHED");
      // The helper does hand the agent a token...
      expect(firstOutput).toMatch(/^1$/m);
      // ...and with it a push is refused, even to the thread's own branch.
      expect(firstOutput).toMatch(/PUSH_EXIT=[1-9]/);
      expect(await github.readBranch(repository, workBranch)).toBeUndefined();
      const firstCommit = readAsAgent(sandboxId, "cd /workspace && git rev-parse HEAD").trim();

      const firstPublication = await publishThread(controlPlane, thread.threadId, true);
      expect(firstPublication).toMatchObject({
        commit: firstCommit,
        pullRequestUrl: `${repository.htmlUrl}/pull/1`,
      });
      expect(await github.readBranch(repository, workBranch)).toBe(firstCommit);
      expect(await readAuthor(repository.directory, firstCommit)).toMatch(
        /^Octo Cat <\d+\+octocat@users\.noreply\.github\.com>$/,
      );
      expect(github.pullRequests).toHaveLength(1);

      expect((await stopThread(controlPlane, thread.threadId)).status).toBe(202);
      await waitUntilSandboxIs(controlPlane, thread.threadId, "stopped");
      const secondTask = [
        "cd /workspace",
        "test -f agent.txt && echo STILL_THERE",
        "echo 'more from the agent' > second.txt",
        "git add second.txt",
        "git commit --quiet --message 'Second change'",
        "git rev-parse HEAD",
      ].join("\n");
      client.sendUserMessage(`${mockModelTriggers.command}${secondTask}`);
      await client.waitUntilRunsHaveSettled(2);
      expect(lastToolOutput(client)).toContain("STILL_THERE");
      const secondCommit = readAsAgent(sandboxId, "cd /workspace && git rev-parse HEAD").trim();
      expect(secondCommit).not.toBe(firstCommit);

      const secondPublication = await publishThread(controlPlane, thread.threadId, true);
      expect(secondPublication).toMatchObject({
        commit: secondCommit,
        pullRequestUrl: `${repository.htmlUrl}/pull/1`,
      });
      expect(await github.readBranch(repository, workBranch)).toBe(secondCommit);
      expect(github.pullRequests).toHaveLength(1);
      expect(countOf(client, "repository_cloned")).toBe(1);
      expect(countOf(client, "repository_clone_started")).toBe(1);

      // The sandbox only ever got read-only tokens for this repository, and
      // none is anywhere it could be read back.
      const sandboxTokens = github.issuedTokens.filter(
        (token) => token.permissions.contents === "read",
      );
      expect(sandboxTokens.length).toBeGreaterThan(0);
      expect(
        sandboxTokens.every((token) => token.repositoryIds.join() === String(repository.id)),
      ).toBe(true);
      const places = {
        history: JSON.stringify(client.messages),
        controlPlaneLog: controlPlane.process.describeOutput(),
        supervisorLog: execFileSync("docker", ["container", "logs", sandboxId], {
          encoding: "utf8",
        }),
        gitConfiguration: readAsAgent(sandboxId, "cat /workspace/.git/config"),
        agentEnvironment: readAsAgent(
          sandboxId,
          "cat /proc/*/environ 2>/dev/null | tr '\\0' '\\n'",
        ),
      };
      for (const { token } of github.issuedTokens) {
        for (const [place, contents] of Object.entries(places)) {
          expect(contents.includes(token), `a token in ${place}`).toBe(false);
        }
      }
    });
  });
}
