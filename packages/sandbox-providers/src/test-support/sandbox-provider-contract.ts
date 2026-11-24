import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SandboxCreationRequest, SandboxProvider } from "../sandbox-provider.js";
import {
  SandboxAlreadyExistsError,
  SandboxNotFoundError,
  SandboxRefusedError,
} from "../sandbox-provider-errors.js";

/**
 * The behaviour every provider must have, run against each of them. A
 * provider is plugged in through a subject that also knows how to observe
 * the sandbox from outside: whether its supervisor was launched, what is on
 * its disk, what the provider says about it, and what a process the
 * provider's own command interface starts can see.
 */
export type ContractSubject = {
  provider: SandboxProvider;
  /** An identifier in the provider's own format that names no sandbox. */
  unknownSandboxId: string;
  /** The supervisor's plain settings for a thread's sandbox; the contract adds the secrets. */
  supervisorEnvironmentFor(threadId: string): Record<string, string>;
  /**
   * Resolves once the thread's supervisor has been launched `launchCount`
   * times in all, so that a second launch proves a start ran it again.
   */
  waitForSupervisorLaunches(threadId: string, launchCount: number): Promise<void>;
  /**
   * Another provider object of the same kind and settings, standing in for
   * the one a control plane started again would make.
   */
  reopenProvider(): SandboxProvider;
  writeFile(sandboxId: string, path: string, content: string): Promise<void>;
  readFile(sandboxId: string, path: string): Promise<string>;
  /** The secret of that name as the supervisor finds it, read as the supervisor's user. */
  readSecretAsSupervisor(sandboxId: string, secretName: string): Promise<string>;
  /**
   * Everything the provider reports about the sandbox to whoever may manage
   * it (Docker's `inspect`, Daytona's sandbox record), as text.
   */
  describeSandboxAsProviderReportsIt(sandboxId: string): Promise<string>;
  /**
   * The provider's own way of running a command in a sandbox (`docker exec`,
   * Daytona's command interface), as the agent's user; or why the provider
   * has none, or no agent user apart from the supervisor's.
   */
  agentCommands: { run: AgentCommandRunner } | { unavailableBecause: string };
  /** Releases whatever the subject set up, such as servers. */
  dispose(): Promise<void>;
};

/** Runs a shell command as the agent's user, through the provider's command interface. */
export type AgentCommandRunner = (
  sandboxId: string,
  shellCommand: string,
) => Promise<{ exitCode: number; output: string }>;

export type ContractTarget = {
  providerName: string;
  /** Why the provider cannot be tested here, or undefined if it can. */
  unavailableReason: string | undefined;
  setUp(): Promise<ContractSubject>;
};

const markerFilePath = "/workspace/contract-marker.txt";
const realProviderTimeoutInMilliseconds = 120_000;
const tokenName = "BARRACK_SUPERVISOR_TOKEN";

function mintToken(): string {
  return randomBytes(32).toString("hex");
}

export function describeSandboxProviderContract(target: ContractTarget): void {
  const title = `the ${target.providerName} sandbox provider`;
  if (target.unavailableReason !== undefined) {
    describe.skip(`${title} (skipped: ${target.unavailableReason})`, () => {
      it("is not tested here", () => {});
    });
    return;
  }

  // Real providers create, stop and start real computers, which takes seconds.
  describe(title, { timeout: realProviderTimeoutInMilliseconds }, () => {
    let subject: ContractSubject;
    const createdSandboxIds: string[] = [];

    beforeAll(async () => {
      subject = await target.setUp();
    }, realProviderTimeoutInMilliseconds);

    // Destroying every sandbox a test made, whether or not it passed, leaves
    // nothing behind on the provider.
    afterEach(async () => {
      await Promise.all(createdSandboxIds.splice(0).map((id) => subject.provider.destroy(id)));
    }, realProviderTimeoutInMilliseconds);

    afterAll(async () => {
      await subject?.dispose();
    }, realProviderTimeoutInMilliseconds);

    function creationRequestFor(threadId: string, token = mintToken()): SandboxCreationRequest {
      return {
        threadId,
        supervisorEnvironment: subject.supervisorEnvironmentFor(threadId),
        supervisorSecrets: { [tokenName]: token },
      };
    }

    async function createSandbox(token = mintToken()) {
      const threadId = `contract-${randomUUID()}`;
      const { sandboxId } = await subject.provider.create(creationRequestFor(threadId, token));
      createdSandboxIds.push(sandboxId);
      return { threadId, sandboxId, token };
    }

    it("creates a running sandbox and launches its supervisor", async () => {
      const { threadId, sandboxId } = await createSandbox();

      expect(await subject.provider.getStatus(sandboxId)).toEqual({ state: "running" });
      await subject.waitForSupervisorLaunches(threadId, 1);
    });

    it("stops a sandbox and starts it again with its files kept and its supervisor launched again", async () => {
      const { threadId, sandboxId } = await createSandbox();
      await subject.waitForSupervisorLaunches(threadId, 1);
      await subject.writeFile(sandboxId, markerFilePath, "kept across a stop");

      await subject.provider.stop(sandboxId);
      const statusWhileStopped = await subject.provider.getStatus(sandboxId);
      await subject.provider.start(sandboxId);

      expect(statusWhileStopped).toEqual({ state: "stopped" });
      expect(await subject.provider.getStatus(sandboxId)).toEqual({ state: "running" });
      await subject.waitForSupervisorLaunches(threadId, 2);
      expect(await subject.readFile(sandboxId, markerFilePath)).toBe("kept across a stop");
    });

    it("hands the supervisor its secrets, keeps them across a stop and a start, and replaces them when a start asks", async () => {
      const { threadId, sandboxId, token } = await createSandbox();
      await subject.waitForSupervisorLaunches(threadId, 1);
      const secretWhenCreated = await subject.readSecretAsSupervisor(sandboxId, tokenName);

      await subject.provider.stop(sandboxId);
      await subject.provider.start(sandboxId);
      await subject.waitForSupervisorLaunches(threadId, 2);
      const secretAfterRestart = await subject.readSecretAsSupervisor(sandboxId, tokenName);
      await subject.provider.stop(sandboxId);
      const replacement = mintToken();
      await subject.provider.start(sandboxId, { replacementSecrets: { [tokenName]: replacement } });
      await subject.waitForSupervisorLaunches(threadId, 3);

      expect(secretWhenCreated).toBe(token);
      expect(secretAfterRestart).toBe(token);
      expect(await subject.readSecretAsSupervisor(sandboxId, tokenName)).toBe(replacement);
    });

    it("never shows a secret in what it reports about the sandbox", async () => {
      const { threadId, sandboxId, token } = await createSandbox();
      await subject.waitForSupervisorLaunches(threadId, 1);

      const report = await subject.describeSandboxAsProviderReportsIt(sandboxId);

      expect(report).toContain(threadId);
      expect(report).not.toContain(token);
    });

    it("keeps secrets from a process its own command interface starts as the agent's user", async (context) => {
      const { agentCommands } = subject;
      if (!("run" in agentCommands)) {
        context.skip(agentCommands.unavailableBecause);
        return;
      }
      const { threadId, sandboxId, token } = await createSandbox();
      await subject.waitForSupervisorLaunches(threadId, 1);

      const environment = await agentCommands.run(sandboxId, "env");
      const secretRead = await agentCommands.run(
        sandboxId,
        `cat "$BARRACK_SUPERVISOR_SECRETS_DIRECTORY/${tokenName}"`,
      );
      const directoryListing = await agentCommands.run(
        sandboxId,
        'ls -la "$BARRACK_SUPERVISOR_SECRETS_DIRECTORY"',
      );

      expect(environment.exitCode).toBe(0);
      expect(environment.output).toContain("BARRACK_SUPERVISOR_SECRETS_DIRECTORY=");
      expect(environment.output).not.toContain(token);
      expect(secretRead.exitCode).not.toBe(0);
      expect(secretRead.output).not.toContain(token);
      expect(directoryListing.exitCode).not.toBe(0);
    });

    it("lets a provider opened afresh, as after a control plane restart, find, stop and start a sandbox an earlier one created", async () => {
      const { threadId, sandboxId } = await createSandbox();
      await subject.waitForSupervisorLaunches(threadId, 1);
      await subject.writeFile(sandboxId, markerFilePath, "kept across a restart");
      const reopened = subject.reopenProvider();

      const statusOnceReopened = await reopened.getStatus(sandboxId);
      await reopened.stop(sandboxId);
      const statusWhileStopped = await subject.provider.getStatus(sandboxId);
      await reopened.start(sandboxId);

      expect(statusOnceReopened).toEqual({ state: "running" });
      expect(statusWhileStopped).toEqual({ state: "stopped" });
      expect(await subject.provider.getStatus(sandboxId)).toEqual({ state: "running" });
      await subject.waitForSupervisorLaunches(threadId, 2);
      expect(await subject.readFile(sandboxId, markerFilePath)).toBe("kept across a restart");
      await expect(reopened.create(creationRequestFor(threadId))).rejects.toMatchObject({
        existingSandboxId: sandboxId,
      });
    });

    it("does nothing when asked to stop a stopped sandbox or start a running one", async () => {
      const { sandboxId } = await createSandbox();

      await subject.provider.start(sandboxId);
      expect(await subject.provider.getStatus(sandboxId)).toEqual({ state: "running" });
      await subject.provider.stop(sandboxId);
      await subject.provider.stop(sandboxId);
      expect(await subject.provider.getStatus(sandboxId)).toEqual({ state: "stopped" });
    });

    it("destroys a sandbox so that it is missing, and does nothing when destroying it again", async () => {
      const { sandboxId } = await createSandbox();

      await subject.provider.destroy(sandboxId);
      await subject.provider.destroy(sandboxId);

      expect(await subject.provider.getStatus(sandboxId)).toEqual({ state: "missing" });
    });

    it("reports a sandbox it does not know as missing", async () => {
      expect(await subject.provider.getStatus(subject.unknownSandboxId)).toEqual({
        state: "missing",
      });
    });

    it("throws not found when asked to start, stop or address a sandbox it does not know", async () => {
      const { unknownSandboxId: sandboxId } = subject;

      await expect(subject.provider.start(sandboxId)).rejects.toThrow(SandboxNotFoundError);
      await expect(subject.provider.stop(sandboxId)).rejects.toThrow(SandboxNotFoundError);
      await expect(
        subject.provider.getServiceAddress({ sandboxId, port: 6080, validForSeconds: 60 }),
      ).rejects.toThrow(SandboxNotFoundError);
    });

    it("refuses a second sandbox for the same thread and names the first", async () => {
      const { threadId, sandboxId } = await createSandbox();

      const secondCreation = subject.provider.create(creationRequestFor(threadId));

      await expect(secondCreation).rejects.toThrow(SandboxAlreadyExistsError);
      await expect(secondCreation).rejects.toMatchObject({ existingSandboxId: sandboxId });
    });

    it("refuses a thread identifier that is not valid, and a secret also given as a setting", async () => {
      const invalidThread = subject.provider.create({
        threadId: "../not a thread",
        supervisorEnvironment: {},
        supervisorSecrets: {},
      });
      const secretAsSetting = subject.provider.create({
        threadId: `contract-${randomUUID()}`,
        supervisorEnvironment: { [tokenName]: "in the open" },
        supervisorSecrets: { [tokenName]: "in a file" },
      });

      await expect(invalidThread).rejects.toThrow(SandboxRefusedError);
      await expect(secretAsSetting).rejects.toThrow(SandboxRefusedError);
    });
  });
}
