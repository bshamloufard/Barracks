import {
  describeServiceAddressLookup,
  validateCreationRequest,
  validateServiceAddressRequest,
} from "../request-validation.js";
import type {
  CreatedSandbox,
  SandboxCreationRequest,
  SandboxProvider,
  SandboxStatus,
  ServiceAddress,
  ServiceAddressRequest,
} from "../sandbox-provider.js";
import {
  SandboxAlreadyExistsError,
  SandboxNotFoundError,
  type SandboxProviderError,
} from "../sandbox-provider-errors.js";

/**
 * An in-memory provider for tests of the control plane. It is deterministic
 * (sandboxes are numbered in order of creation), records every call, and lets
 * a test change a sandbox's state from outside or make the next operation
 * fail, so lifecycle code can be tested without Docker or a cloud account.
 *
 * Given a supervisor launcher, it runs it whenever a sandbox starts running,
 * so a test can attach a real or fake supervisor that connects to the
 * control plane under test.
 */

export type FakeSandboxOperation = keyof SandboxProvider;

export type FakeSandboxProviderCall =
  | { operation: "create"; request: SandboxCreationRequest }
  | { operation: "getServiceAddress"; request: ServiceAddressRequest }
  | { operation: "start" | "stop" | "destroy" | "getStatus"; sandboxId: string };

/** What a supervisor launcher is told about the sandbox it runs in. */
export type FakeSandboxLaunch = {
  sandboxId: string;
  threadId: string;
  supervisorEnvironment: Readonly<Record<string, string>>;
  /** The sandbox's disk: kept across stop and start, gone on destroy. */
  files: Map<string, string>;
};

/** A supervisor a launcher started; the fake stops it when its sandbox stops. */
export type LaunchedSupervisor = { stop(): Promise<void> };

export type SupervisorLauncher = (
  launch: FakeSandboxLaunch,
) => Promise<LaunchedSupervisor | undefined> | LaunchedSupervisor | undefined;

export type FakeSandboxProviderOptions = {
  supervisorLauncher?: SupervisorLauncher;
  /** The clock used for service address expiry. */
  now?: () => Date;
};

type FakeSandbox = FakeSandboxLaunch & {
  status: SandboxStatus;
  launchedSupervisor: LaunchedSupervisor | undefined;
};

type PlannedFailure = { error: SandboxProviderError; operation: FakeSandboxOperation | undefined };

export class FakeSandboxProvider implements SandboxProvider {
  /** Every call made to the provider, in order, including ones made to fail. */
  readonly calls: FakeSandboxProviderCall[] = [];
  readonly #sandboxes = new Map<string, FakeSandbox>();
  readonly #supervisorLauncher: SupervisorLauncher | undefined;
  readonly #now: () => Date;
  #plannedFailure: PlannedFailure | undefined;
  #createdCount = 0;

  constructor(options: FakeSandboxProviderOptions = {}) {
    this.#supervisorLauncher = options.supervisorLauncher;
    this.#now = options.now ?? (() => new Date());
  }

  async create(request: SandboxCreationRequest): Promise<CreatedSandbox> {
    this.calls.push({ operation: "create", request });
    this.#failIfPlanned("create");
    validateCreationRequest(request);
    const existing = this.#findByThread(request.threadId);
    if (existing !== undefined) {
      throw new SandboxAlreadyExistsError(request.threadId, existing.sandboxId);
    }
    this.#createdCount += 1;
    const sandbox: FakeSandbox = {
      sandboxId: `fake-sandbox-${this.#createdCount}`,
      threadId: request.threadId,
      supervisorEnvironment: { ...request.supervisorEnvironment },
      files: new Map(),
      status: { state: "starting" },
      launchedSupervisor: undefined,
    };
    this.#sandboxes.set(sandbox.sandboxId, sandbox);
    await this.#run(sandbox);
    return { sandboxId: sandbox.sandboxId };
  }

  async start(sandboxId: string): Promise<void> {
    this.calls.push({ operation: "start", sandboxId });
    this.#failIfPlanned("start");
    const sandbox = this.#require(`start sandbox "${sandboxId}"`, sandboxId);
    if (sandbox.status.state === "running") {
      return;
    }
    await this.#run(sandbox);
  }

  async stop(sandboxId: string): Promise<void> {
    this.calls.push({ operation: "stop", sandboxId });
    this.#failIfPlanned("stop");
    const sandbox = this.#require(`stop sandbox "${sandboxId}"`, sandboxId);
    await this.#halt(sandbox, { state: "stopped" });
  }

  async destroy(sandboxId: string): Promise<void> {
    this.calls.push({ operation: "destroy", sandboxId });
    this.#failIfPlanned("destroy");
    const sandbox = this.#sandboxes.get(sandboxId);
    if (sandbox === undefined) {
      return;
    }
    await this.#halt(sandbox, { state: "stopped" });
    this.#sandboxes.delete(sandboxId);
  }

  async getStatus(sandboxId: string): Promise<SandboxStatus> {
    this.calls.push({ operation: "getStatus", sandboxId });
    this.#failIfPlanned("getStatus");
    return this.#sandboxes.get(sandboxId)?.status ?? { state: "missing" };
  }

  async getServiceAddress(request: ServiceAddressRequest): Promise<ServiceAddress> {
    this.calls.push({ operation: "getServiceAddress", request });
    this.#failIfPlanned("getServiceAddress");
    validateServiceAddressRequest(request);
    this.#require(describeServiceAddressLookup(request), request.sandboxId);
    const expiresAt = new Date(this.#now().getTime() + request.validForSeconds * 1000);
    return {
      url: `https://${request.port}-${request.sandboxId}.fake-sandbox.invalid/`,
      expiresAt,
      reachableBy: "anyone-with-the-url",
    };
  }

  /**
   * Makes the next operation throw `error` instead of doing anything (the
   * call is still recorded). With `operation`, only the next call of that
   * operation fails.
   */
  failNextOperation(error: SandboxProviderError, operation?: FakeSandboxOperation): void {
    this.#plannedFailure = { error, operation };
  }

  /** Stops a sandbox as if the provider had (its supervisor is stopped too). */
  async markStopped(sandboxId: string): Promise<void> {
    await this.#halt(this.#require(`mark sandbox "${sandboxId}" stopped`, sandboxId), {
      state: "stopped",
    });
  }

  /** Puts a sandbox in the failed state, as if it had crashed. */
  async markFailed(sandboxId: string, reason: string): Promise<void> {
    await this.#halt(this.#require(`mark sandbox "${sandboxId}" failed`, sandboxId), {
      state: "failed",
      reason,
    });
  }

  /** Forgets a sandbox, as if the provider had lost or deleted it. */
  async markMissing(sandboxId: string): Promise<void> {
    const sandbox = this.#require(`mark sandbox "${sandboxId}" missing`, sandboxId);
    await this.#halt(sandbox, { state: "stopped" });
    this.#sandboxes.delete(sandboxId);
  }

  /** The sandbox's disk, for a test to put files on or check them; undefined if missing. */
  filesOf(sandboxId: string): Map<string, string> | undefined {
    return this.#sandboxes.get(sandboxId)?.files;
  }

  /** The identifiers of every sandbox that exists, in order of creation. */
  sandboxIds(): string[] {
    return [...this.#sandboxes.keys()];
  }

  async #run(sandbox: FakeSandbox): Promise<void> {
    sandbox.status = { state: "starting" };
    sandbox.launchedSupervisor = (await this.#supervisorLauncher?.(sandbox)) ?? undefined;
    sandbox.status = { state: "running" };
  }

  async #halt(sandbox: FakeSandbox, status: SandboxStatus): Promise<void> {
    const launchedSupervisor = sandbox.launchedSupervisor;
    sandbox.launchedSupervisor = undefined;
    sandbox.status = status;
    await launchedSupervisor?.stop();
  }

  #require(attemptedOperation: string, sandboxId: string): FakeSandbox {
    const sandbox = this.#sandboxes.get(sandboxId);
    if (sandbox === undefined) {
      throw new SandboxNotFoundError(attemptedOperation, sandboxId);
    }
    return sandbox;
  }

  #findByThread(threadId: string): FakeSandbox | undefined {
    return [...this.#sandboxes.values()].find((sandbox) => sandbox.threadId === threadId);
  }

  #failIfPlanned(operation: FakeSandboxOperation): void {
    const planned = this.#plannedFailure;
    if (planned === undefined || (planned.operation ?? operation) !== operation) {
      return;
    }
    this.#plannedFailure = undefined;
    throw planned.error;
  }
}
