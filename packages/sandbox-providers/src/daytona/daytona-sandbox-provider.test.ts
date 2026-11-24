import { describe, expect, it } from "vitest";
import {
  SandboxAlreadyExistsError,
  SandboxNotFoundError,
  SandboxProviderUnavailableError,
  SandboxRefusedError,
} from "../sandbox-provider-errors.js";
import {
  type DaytonaApi,
  DaytonaApiFailure,
  type DaytonaCreationParameters,
  type DaytonaSandboxRecord,
} from "./daytona-api.js";
import {
  type DaytonaProviderSettings,
  DaytonaSandboxProvider,
} from "./daytona-sandbox-provider.js";

/**
 * The provider's logic against an in-memory stand-in for Daytona's API. No
 * Daytona account is involved; the live behaviour is covered by the contract
 * tests when credentials are available.
 */

const settings: DaytonaProviderSettings = {
  snapshot: "barrack-sandbox-test",
  target: "eu",
  autoArchiveIntervalInMinutes: 60,
};

const supervisorEnvironment = { BARRACK_THREAD_ID: "thread-1", BARRACK_SUPERVISOR_TOKEN: "secret" };

type ApiCall = { method: keyof DaytonaApi; sandboxId?: string; detail?: unknown };

class InMemoryDaytona implements DaytonaApi {
  readonly calls: ApiCall[] = [];
  readonly sandboxes = new Map<string, DaytonaSandboxRecord & { name: string }>();
  supervisorLaunchExitCode = 0;
  /** What every call of each method listed here throws, as Daytona would fail. */
  readonly failures = new Map<keyof DaytonaApi, DaytonaApiFailure>();
  #count = 0;

  async createSandbox(parameters: DaytonaCreationParameters): Promise<DaytonaSandboxRecord> {
    this.calls.push({ method: "createSandbox", detail: parameters });
    this.#count += 1;
    const sandbox = {
      id: `daytona-${this.#count}`,
      name: parameters.name,
      state: "started",
      errorReason: undefined,
      labels: parameters.labels,
      environment: parameters.envVars,
    };
    this.sandboxes.set(sandbox.id, sandbox);
    return sandbox;
  }

  async findSandbox(idOrName: string): Promise<DaytonaSandboxRecord | undefined> {
    return [...this.sandboxes.values()].find(
      (sandbox) => sandbox.id === idOrName || sandbox.name === idOrName,
    );
  }

  async startSandbox(sandboxId: string): Promise<void> {
    this.calls.push({ method: "startSandbox", sandboxId });
    this.#setState(sandboxId, "started");
  }

  async stopSandbox(sandboxId: string): Promise<void> {
    this.calls.push({ method: "stopSandbox", sandboxId });
    this.#throwIfFailing("stopSandbox");
    this.#setState(sandboxId, "stopped");
  }

  async waitUntilStarted(sandboxId: string): Promise<void> {
    this.calls.push({ method: "waitUntilStarted", sandboxId });
    this.#setState(sandboxId, "started");
  }

  async waitUntilStopped(sandboxId: string): Promise<void> {
    this.calls.push({ method: "waitUntilStopped", sandboxId });
    this.#setState(sandboxId, "stopped");
  }

  async deleteSandbox(sandboxId: string): Promise<void> {
    this.calls.push({ method: "deleteSandbox", sandboxId });
    this.#throwIfFailing("deleteSandbox");
    this.sandboxes.delete(sandboxId);
  }

  async executeCommand(
    sandboxId: string,
    command: string,
    environment: Readonly<Record<string, string>> | undefined,
  ) {
    this.calls.push({ method: "executeCommand", sandboxId, detail: { command, environment } });
    this.#throwIfFailing("executeCommand");
    return { exitCode: this.supervisorLaunchExitCode, output: "" };
  }

  async createSignedPreviewUrl(sandboxId: string, port: number, expiresInSeconds: number) {
    this.calls.push({
      method: "createSignedPreviewUrl",
      sandboxId,
      detail: { port, expiresInSeconds },
    });
    return { url: `https://${port}-signed-token.proxy.daytona.example` };
  }

  setState(sandboxId: string, state: string): void {
    this.#setState(sandboxId, state);
  }

  callsTo(method: keyof DaytonaApi): ApiCall[] {
    return this.calls.filter((call) => call.method === method);
  }

  #throwIfFailing(method: keyof DaytonaApi): void {
    const failure = this.failures.get(method);
    if (failure !== undefined) {
      throw failure;
    }
  }

  #setState(sandboxId: string, state: string): void {
    const sandbox = this.sandboxes.get(sandboxId);
    if (sandbox !== undefined) {
      sandbox.state = state;
    }
  }
}

function createProvider(daytona = new InMemoryDaytona()) {
  const now = () => new Date("2026-11-24T12:00:00Z");
  return { daytona, provider: new DaytonaSandboxProvider(settings, daytona, now) };
}

describe("the Daytona sandbox provider", () => {
  it("creates sandboxes with Daytona's own lifecycle timers off, except archiving, and the agent's user named", async () => {
    const { daytona, provider } = createProvider();

    await provider.create({ threadId: "thread-1", supervisorEnvironment });

    expect(daytona.callsTo("createSandbox")[0]?.detail).toEqual({
      name: "barrack-thread-thread-1",
      snapshot: "barrack-sandbox-test",
      envVars: { BARRACK_AGENT_USER: "barrack-agent", ...supervisorEnvironment },
      labels: { "barrack.sandbox": "true", "barrack.thread-id": "thread-1" },
      public: false,
      autoStopInterval: 0,
      autoArchiveInterval: 60,
      autoDeleteInterval: -1,
      target: "eu",
    });
  });

  it("launches the supervisor, with the sandbox's environment, after creating and after every start", async () => {
    const { daytona, provider } = createProvider();

    const { sandboxId } = await provider.create({ threadId: "thread-1", supervisorEnvironment });
    await provider.stop(sandboxId);
    await provider.start(sandboxId);
    await provider.start(sandboxId);

    const launches = daytona.callsTo("executeCommand");
    expect(launches).toHaveLength(3);
    expect(launches[0]?.detail).toEqual({
      command: "/usr/local/bin/barrack-ensure-supervisor",
      environment: { BARRACK_AGENT_USER: "barrack-agent", ...supervisorEnvironment },
    });
    expect(daytona.callsTo("startSandbox")).toHaveLength(1);
  });

  it("deletes a sandbox whose supervisor could not be launched and reports the launch failure", async () => {
    const { daytona, provider } = createProvider();
    daytona.supervisorLaunchExitCode = 1;

    const creation = provider.create({ threadId: "thread-1", supervisorEnvironment });

    await expect(creation).rejects.toThrow(SandboxRefusedError);
    await expect(creation).rejects.toThrow(/could not launch its supervisor \(exit code 1\)/);
    expect(daytona.callsTo("deleteSandbox")).toEqual([
      { method: "deleteSandbox", sandboxId: "daytona-1" },
    ]);
    expect(daytona.sandboxes.size).toBe(0);
  });

  it("creates a fresh sandbox on the retry after a launch that could not reach Daytona", async () => {
    const { daytona, provider } = createProvider();
    daytona.failures.set("executeCommand", new DaytonaApiFailure("timed out", undefined, true));

    const firstAttempt = provider.create({ threadId: "thread-1", supervisorEnvironment });
    await expect(firstAttempt).rejects.toThrow(SandboxProviderUnavailableError);
    daytona.failures.delete("executeCommand");
    const retry = await provider.create({ threadId: "thread-1", supervisorEnvironment });

    expect(retry).toEqual({ sandboxId: "daytona-2" });
    expect([...daytona.sandboxes.keys()]).toEqual(["daytona-2"]);
  });

  it("reports both failures, as a refusal naming the sandbox left behind, when the sandbox cannot be deleted either", async () => {
    const { daytona, provider } = createProvider();
    daytona.failures.set("executeCommand", new DaytonaApiFailure("timed out", undefined, true));
    daytona.failures.set("deleteSandbox", new DaytonaApiFailure("bad gateway", 502, false));

    const creation = provider.create({ threadId: "thread-1", supervisorEnvironment });

    await expect(creation).rejects.toThrow(SandboxRefusedError);
    await expect(creation).rejects.toThrow(
      'Could not create a sandbox for thread "thread-1": Daytona said "timed out"; undoing it failed too (Could not delete sandbox "daytona-1": Daytona said "bad gateway"), so sandbox "daytona-1" is left behind and must be deleted by hand before the thread can have another',
    );
  });

  it("stops a started sandbox whose supervisor could not be launched instead of leaving it running", async () => {
    const { daytona, provider } = createProvider();
    const { sandboxId } = await provider.create({ threadId: "thread-1", supervisorEnvironment });
    await provider.stop(sandboxId);
    daytona.supervisorLaunchExitCode = 1;

    await expect(provider.start(sandboxId)).rejects.toThrow(/could not launch its supervisor/);

    expect(await provider.getStatus(sandboxId)).toEqual({ state: "stopped" });
  });

  it("reports both failures when a started sandbox without its supervisor cannot be stopped", async () => {
    const { daytona, provider } = createProvider();
    const { sandboxId } = await provider.create({ threadId: "thread-1", supervisorEnvironment });
    daytona.supervisorLaunchExitCode = 1;
    daytona.failures.set("stopSandbox", new DaytonaApiFailure("bad gateway", 502, false));

    const start = provider.start(sandboxId);

    await expect(start).rejects.toThrow(SandboxRefusedError);
    await expect(start).rejects.toThrow(
      /exit code 1.*undoing it failed too \(Could not stop sandbox "daytona-1": Daytona said "bad gateway"\), so sandbox "daytona-1" may be running without its supervisor/,
    );
  });

  it("names the thread's existing sandbox instead of creating a second one", async () => {
    const { daytona, provider } = createProvider();
    const { sandboxId } = await provider.create({ threadId: "thread-1", supervisorEnvironment });

    const secondCreation = provider.create({ threadId: "thread-1", supervisorEnvironment });

    await expect(secondCreation).rejects.toThrow(SandboxAlreadyExistsError);
    await expect(secondCreation).rejects.toMatchObject({ existingSandboxId: sandboxId });
    expect(daytona.callsTo("createSandbox")).toHaveLength(1);
  });

  it("does not stop a sandbox that is already stopped or archived", async () => {
    const { daytona, provider } = createProvider();
    const { sandboxId } = await provider.create({ threadId: "thread-1", supervisorEnvironment });
    daytona.setState(sandboxId, "archived");

    await provider.stop(sandboxId);

    expect(daytona.callsTo("stopSandbox")).toEqual([]);
    expect(await provider.getStatus(sandboxId)).toEqual({ state: "stopped" });
  });

  it("waits for a sandbox that is already starting rather than starting it again", async () => {
    const { daytona, provider } = createProvider();
    const { sandboxId } = await provider.create({ threadId: "thread-1", supervisorEnvironment });
    daytona.setState(sandboxId, "restoring");

    await provider.start(sandboxId);

    expect(daytona.callsTo("waitUntilStarted")).toHaveLength(1);
    expect(daytona.callsTo("startSandbox")).toEqual([]);
  });

  it("asks the caller to try again later when starting a sandbox that is still stopping", async () => {
    const { daytona, provider } = createProvider();
    const { sandboxId } = await provider.create({ threadId: "thread-1", supervisorEnvironment });
    daytona.setState(sandboxId, "stopping");

    await expect(provider.start(sandboxId)).rejects.toThrow(SandboxProviderUnavailableError);
  });

  it("destroys a sandbox and does nothing when it is already gone", async () => {
    const { daytona, provider } = createProvider();
    const { sandboxId } = await provider.create({ threadId: "thread-1", supervisorEnvironment });

    await provider.destroy(sandboxId);
    await provider.destroy(sandboxId);

    expect(daytona.callsTo("deleteSandbox")).toHaveLength(1);
    expect(await provider.getStatus(sandboxId)).toEqual({ state: "missing" });
  });

  it("treats a sandbox without Barrack's label as one it does not know", async () => {
    const { daytona, provider } = createProvider();
    daytona.sandboxes.set("someone-elses", {
      id: "someone-elses",
      name: "someone-elses",
      state: "started",
      errorReason: undefined,
      labels: {},
      environment: undefined,
    });

    expect(await provider.getStatus("someone-elses")).toEqual({ state: "missing" });
    await expect(provider.stop("someone-elses")).rejects.toThrow(SandboxNotFoundError);
    await provider.destroy("someone-elses");
    expect(daytona.callsTo("deleteSandbox")).toEqual([]);
  });

  it("hands out a signed URL for one port, expiring when asked and never later than Daytona allows", async () => {
    const { daytona, provider } = createProvider();
    const { sandboxId } = await provider.create({ threadId: "thread-1", supervisorEnvironment });

    const shortLived = await provider.getServiceAddress({
      sandboxId,
      port: 6080,
      validForSeconds: 600,
    });
    const asLongAsAllowed = await provider.getServiceAddress({
      sandboxId,
      port: 6080,
      validForSeconds: 7 * 86_400,
    });

    expect(shortLived).toEqual({
      url: "https://6080-signed-token.proxy.daytona.example",
      expiresAt: new Date("2026-11-24T12:10:00Z"),
      reachableBy: "anyone-with-the-url",
    });
    expect(asLongAsAllowed.expiresAt).toEqual(new Date("2026-11-25T12:00:00Z"));
    expect(daytona.callsTo("createSignedPreviewUrl").map((call) => call.detail)).toEqual([
      { port: 6080, expiresInSeconds: 600 },
      { port: 6080, expiresInSeconds: 86_400 },
    ]);
  });

  it("reports Daytona being unreachable as unavailable", async () => {
    const daytona = new InMemoryDaytona();
    daytona.findSandbox = async () => {
      throw new DaytonaApiFailure("connect ECONNREFUSED", undefined, true);
    };
    const { provider } = createProvider(daytona);

    await expect(provider.getStatus("daytona-1")).rejects.toThrow(SandboxProviderUnavailableError);
  });
});
