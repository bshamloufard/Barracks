import { describe, expect, it, vi } from "vitest";
import {
  SandboxNotFoundError,
  SandboxProviderUnavailableError,
  SandboxRefusedError,
} from "../sandbox-provider-errors.js";
import { FakeSandboxProvider } from "./fake-sandbox-provider.js";

const environment = { BARRACK_THREAD_ID: "thread-1" };
const secrets = { BARRACK_SUPERVISOR_TOKEN: "secret" };

describe("the fake sandbox provider", () => {
  it("numbers sandboxes in the order they are created", async () => {
    const provider = new FakeSandboxProvider();

    const first = await provider.create({
      threadId: "thread-1",
      supervisorEnvironment: {},
      supervisorSecrets: {},
    });
    const second = await provider.create({
      threadId: "thread-2",
      supervisorEnvironment: {},
      supervisorSecrets: {},
    });

    expect([first.sandboxId, second.sandboxId]).toEqual(["fake-sandbox-1", "fake-sandbox-2"]);
  });

  it("records every call in order, with what it was asked", async () => {
    const provider = new FakeSandboxProvider();

    const { sandboxId } = await provider.create({
      threadId: "thread-1",
      supervisorEnvironment: environment,
      supervisorSecrets: secrets,
    });
    await provider.stop(sandboxId);
    await provider.getStatus(sandboxId);

    expect(provider.calls).toEqual([
      {
        operation: "create",
        request: {
          threadId: "thread-1",
          supervisorEnvironment: environment,
          supervisorSecrets: secrets,
        },
      },
      { operation: "stop", sandboxId },
      { operation: "getStatus", sandboxId },
    ]);
  });

  it("launches the supervisor with the sandbox's environment on create and on every start, and stops it on stop", async () => {
    const stopSupervisor = vi.fn(async () => {});
    const launcher = vi.fn(() => ({ stop: stopSupervisor }));
    const provider = new FakeSandboxProvider({ supervisorLauncher: launcher });

    const { sandboxId } = await provider.create({
      threadId: "thread-1",
      supervisorEnvironment: environment,
      supervisorSecrets: secrets,
    });
    await provider.stop(sandboxId);
    await provider.start(sandboxId);

    expect(launcher).toHaveBeenCalledTimes(2);
    expect(launcher).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sandboxId,
        threadId: "thread-1",
        supervisorEnvironment: environment,
        supervisorSecrets: secrets,
      }),
    );
    expect(stopSupervisor).toHaveBeenCalledTimes(1);
  });

  it("fails only the next operation when told to", async () => {
    const provider = new FakeSandboxProvider();
    const { sandboxId } = await provider.create({
      threadId: "thread-1",
      supervisorEnvironment: {},
      supervisorSecrets: {},
    });
    const outage = new SandboxProviderUnavailableError("stop", "the fake is down");

    provider.failNextOperation(outage);

    await expect(provider.stop(sandboxId)).rejects.toBe(outage);
    await expect(provider.stop(sandboxId)).resolves.toBeUndefined();
  });

  it("fails only the named operation when told which one", async () => {
    const provider = new FakeSandboxProvider();
    const refusal = new SandboxRefusedError("create", "quota reached");

    provider.failNextOperation(refusal, "create");
    await provider.getStatus("fake-sandbox-1");

    await expect(
      provider.create({ threadId: "thread-1", supervisorEnvironment: {}, supervisorSecrets: {} }),
    ).rejects.toBe(refusal);
  });

  it("lets a test mark a sandbox failed, stopped or missing from outside", async () => {
    const stopSupervisor = vi.fn(async () => {});
    const provider = new FakeSandboxProvider({
      supervisorLauncher: () => ({ stop: stopSupervisor }),
    });
    const { sandboxId } = await provider.create({
      threadId: "thread-1",
      supervisorEnvironment: {},
      supervisorSecrets: {},
    });

    await provider.markFailed(sandboxId, "the supervisor crashed");
    const failedStatus = await provider.getStatus(sandboxId);
    await provider.start(sandboxId);
    await provider.markStopped(sandboxId);
    const stoppedStatus = await provider.getStatus(sandboxId);
    await provider.markMissing(sandboxId);

    expect(failedStatus).toEqual({ state: "failed", reason: "the supervisor crashed" });
    expect(stoppedStatus).toEqual({ state: "stopped" });
    expect(await provider.getStatus(sandboxId)).toEqual({ state: "missing" });
    await expect(provider.start(sandboxId)).rejects.toThrow(SandboxNotFoundError);
    expect(stopSupervisor).toHaveBeenCalledTimes(2);
  });

  it("hands out service addresses that expire when asked", async () => {
    const provider = new FakeSandboxProvider({ now: () => new Date("2026-11-24T12:00:00Z") });
    const { sandboxId } = await provider.create({
      threadId: "thread-1",
      supervisorEnvironment: {},
      supervisorSecrets: {},
    });

    const address = await provider.getServiceAddress({
      sandboxId,
      port: 6080,
      validForSeconds: 60,
    });

    expect(address).toEqual({
      url: "https://6080-fake-sandbox-1.fake-sandbox.invalid/",
      expiresAt: new Date("2026-11-24T12:01:00Z"),
      reachableBy: "anyone-with-the-url",
    });
  });
});
