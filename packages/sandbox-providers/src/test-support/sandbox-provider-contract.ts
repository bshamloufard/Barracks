import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SandboxProvider } from "../sandbox-provider.js";
import {
  SandboxAlreadyExistsError,
  SandboxNotFoundError,
  SandboxRefusedError,
} from "../sandbox-provider-errors.js";

/**
 * The behaviour every provider must have, run against each of them. A
 * provider is plugged in through a subject that also knows how to observe
 * the sandbox from outside: whether its supervisor was launched, and what
 * is on its disk.
 */
export type ContractSubject = {
  provider: SandboxProvider;
  /** An identifier in the provider's own format that names no sandbox. */
  unknownSandboxId: string;
  /** The environment to create a thread's sandbox with. */
  supervisorEnvironmentFor(threadId: string): Record<string, string>;
  /**
   * Resolves once the thread's supervisor has been launched `launchCount`
   * times in all, so that a second launch proves a start ran it again.
   */
  waitForSupervisorLaunches(threadId: string, launchCount: number): Promise<void>;
  writeFile(sandboxId: string, path: string, content: string): Promise<void>;
  readFile(sandboxId: string, path: string): Promise<string>;
  /** Releases whatever the subject set up, such as servers. */
  dispose(): Promise<void>;
};

export type ContractTarget = {
  providerName: string;
  /** Why the provider cannot be tested here, or undefined if it can. */
  unavailableReason: string | undefined;
  setUp(): Promise<ContractSubject>;
};

const markerFilePath = "/workspace/contract-marker.txt";
const realProviderTimeoutInMilliseconds = 120_000;

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

    async function createSandbox(): Promise<{ threadId: string; sandboxId: string }> {
      const threadId = `contract-${randomUUID()}`;
      const { sandboxId } = await subject.provider.create({
        threadId,
        supervisorEnvironment: subject.supervisorEnvironmentFor(threadId),
      });
      createdSandboxIds.push(sandboxId);
      return { threadId, sandboxId };
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

      const secondCreation = subject.provider.create({
        threadId,
        supervisorEnvironment: subject.supervisorEnvironmentFor(threadId),
      });

      await expect(secondCreation).rejects.toThrow(SandboxAlreadyExistsError);
      await expect(secondCreation).rejects.toMatchObject({ existingSandboxId: sandboxId });
    });

    it("refuses a thread identifier that is not valid", async () => {
      const creation = subject.provider.create({
        threadId: "../not a thread",
        supervisorEnvironment: {},
      });

      await expect(creation).rejects.toThrow(SandboxRefusedError);
    });
  });
}
