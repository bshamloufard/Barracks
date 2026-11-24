import { SandboxProviderUnavailableError } from "@barrack/sandbox-providers";
import { pino } from "pino";
import { describe, expect, it } from "vitest";
import { recordTestThread } from "../test-support/record-test-thread.js";
import { InMemoryThreadStore } from "../threads/in-memory-thread-store.js";
import type { LifecycleTiming } from "./lifecycle-settings.js";
import { LeaseLostError, OperationLeases } from "./operation-lease.js";

const logger = pino({ level: "silent" });

const timing: LifecycleTiming = {
  leaseDurationInMilliseconds: 60_000,
  leaseRenewalIntervalInMilliseconds: 15_000,
  providerRetryDelaysInMilliseconds: [0, 0],
  interruptGracePeriodInMilliseconds: 0,
  agentActivityRecordingIntervalInMilliseconds: 0,
  supervisorAttachmentDeadlineInMilliseconds: 0,
};

function createLeases(threadStore = new InMemoryThreadStore()): OperationLeases {
  return new OperationLeases({ threadStore, clock: () => new Date(), timing });
}

function unavailable(): SandboxProviderUnavailableError {
  return new SandboxProviderUnavailableError("start sandbox one", "the network is down");
}

describe("an operation's lease", () => {
  it("lets the work's result through while the thread is still at the version handed over", async () => {
    const threadStore = new InMemoryThreadStore();
    const thread = await recordTestThread(threadStore, { threadId: "thread-1", ownerUserId: "u" });
    const result = await createLeases(threadStore).hold(thread, logger, async () => "made");
    expect(result).toBe("made");
  });

  it("is found lost, however the work ended, once the thread has moved on", async () => {
    const threadStore = new InMemoryThreadStore();
    const thread = await recordTestThread(threadStore, { threadId: "thread-1", ownerUserId: "u" });
    const movedOn = { ...thread, version: thread.version - 1 };
    const leases = createLeases(threadStore);
    await expect(leases.hold(movedOn, logger, async () => "made")).rejects.toBeInstanceOf(
      LeaseLostError,
    );
    await expect(
      leases.hold(movedOn, logger, async () => {
        throw new Error("The provider refused.");
      }),
    ).rejects.toBeInstanceOf(LeaseLostError);
  });
});

describe("a provider call under a lease", () => {
  it("is tried again while the provider is unavailable, as often as there are pauses", async () => {
    let attemptCount = 0;
    const result = await createLeases().callProvider(
      "start the sandbox",
      { isLost: () => false },
      logger,
      async () => {
        attemptCount += 1;
        if (attemptCount < 3) {
          throw unavailable();
        }
        return "started";
      },
    );
    expect(result).toBe("started");
    expect(attemptCount).toBe(3);
  });

  it("is not tried again once the lease is lost, or for any other failure", async () => {
    let attemptCount = 0;
    const leases = createLeases();
    await expect(
      leases.callProvider("start the sandbox", { isLost: () => true }, logger, async () => {
        attemptCount += 1;
        throw unavailable();
      }),
    ).rejects.toBeInstanceOf(SandboxProviderUnavailableError);
    expect(attemptCount).toBe(1);
    await expect(
      leases.callProvider("start the sandbox", { isLost: () => false }, logger, async () => {
        attemptCount += 1;
        throw new Error("The provider refused.");
      }),
    ).rejects.toThrow("The provider refused.");
    expect(attemptCount).toBe(2);
  });
});
