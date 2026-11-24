import {
  describeServiceAddressLookup,
  validateCreationRequest,
  validateServiceAddressRequest,
  validateStartOptions,
} from "../request-validation.js";
import type {
  CreatedSandbox,
  SandboxCreationRequest,
  SandboxProvider,
  SandboxStartOptions,
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
  | { operation: "start"; sandboxId: string; options: SandboxStartOptions | undefined }
  | { operation: "stop" | "destroy" | "getStatus"; sandboxId: string };

/** What a supervisor launcher is told about the sandbox it runs in. */
export type FakeSandboxLaunch = {
  sandboxId: string;
  threadId: string;
  supervisorEnvironment: Readonly<Record<string, string>>;
  /** The secrets the supervisor finds, as given at creation and replaced by any start since. */
  supervisorSecrets: Readonly<Record<string, string>>;
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

/** The sandboxes themselves, which outlive any one provider object, as a real provider's do. */
type FakeSandboxWorld = { sandboxes: Map<string, FakeSandbox>; createdCount: number };

export class FakeSandboxProvider implements SandboxProvider {
  /** Every call made to the provider, in order, including ones made to fail. */
  readonly calls: FakeSandboxProviderCall[] = [];
  readonly #options: FakeSandboxProviderOptions;
  readonly #world: FakeSandboxWorld;
  readonly #sandboxes: Map<string, FakeSandbox>;
  readonly #supervisorLauncher: SupervisorLauncher | undefined;
  readonly #now: () => Date;
  #plannedFailure: PlannedFailure | undefined;
  readonly #heldOperations = new Map<FakeSandboxOperation, Promise<void>>();

  constructor(
    options: FakeSandboxProviderOptions = {},
    world: FakeSandboxWorld = { sandboxes: new Map(), createdCount: 0 },
  ) {
    this.#options = options;
    this.#world = world;
    this.#sandboxes = world.sandboxes;
    this.#supervisorLauncher = options.supervisorLauncher;
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * A second provider object over the same sandboxes, as a control plane
   * started again gets: it sees, stops and starts what this one created.
   */
  reopen(): FakeSandboxProvider {
    return new FakeSandboxProvider(this.#options, this.#world);
  }

  async create(request: SandboxCreationRequest): Promise<CreatedSandbox> {
    this.calls.push({ operation: "create", request });
    await this.#beforeOperation("create");
    validateCreationRequest(request);
    const existing = this.#findByThread(request.threadId);
    if (existing !== undefined) {
      throw new SandboxAlreadyExistsError(request.threadId, existing.sandboxId);
    }
    this.#world.createdCount += 1;
    const sandbox: FakeSandbox = {
      sandboxId: `fake-sandbox-${this.#world.createdCount}`,
      threadId: request.threadId,
      supervisorEnvironment: { ...request.supervisorEnvironment },
      supervisorSecrets: { ...request.supervisorSecrets },
      files: new Map(),
      status: { state: "starting" },
      launchedSupervisor: undefined,
    };
    this.#sandboxes.set(sandbox.sandboxId, sandbox);
    await this.#run(sandbox);
    return { sandboxId: sandbox.sandboxId };
  }

  async start(sandboxId: string, options?: SandboxStartOptions): Promise<void> {
    this.calls.push({ operation: "start", sandboxId, options });
    await this.#beforeOperation("start");
    const attemptedOperation = `start sandbox "${sandboxId}"`;
    validateStartOptions(options, attemptedOperation);
    const sandbox = this.#require(attemptedOperation, sandboxId);
    sandbox.supervisorSecrets = { ...sandbox.supervisorSecrets, ...options?.replacementSecrets };
    if (sandbox.status.state === "running") {
      return;
    }
    await this.#run(sandbox);
  }

  async stop(sandboxId: string): Promise<void> {
    this.calls.push({ operation: "stop", sandboxId });
    await this.#beforeOperation("stop");
    const sandbox = this.#require(`stop sandbox "${sandboxId}"`, sandboxId);
    await this.#halt(sandbox, { state: "stopped" });
  }

  async destroy(sandboxId: string): Promise<void> {
    this.calls.push({ operation: "destroy", sandboxId });
    await this.#beforeOperation("destroy");
    const sandbox = this.#sandboxes.get(sandboxId);
    if (sandbox === undefined) {
      return;
    }
    await this.#halt(sandbox, { state: "stopped" });
    this.#sandboxes.delete(sandboxId);
  }

  async getStatus(sandboxId: string): Promise<SandboxStatus> {
    this.calls.push({ operation: "getStatus", sandboxId });
    await this.#beforeOperation("getStatus");
    return this.#sandboxes.get(sandboxId)?.status ?? { state: "missing" };
  }

  async getServiceAddress(request: ServiceAddressRequest): Promise<ServiceAddress> {
    this.calls.push({ operation: "getServiceAddress", request });
    await this.#beforeOperation("getServiceAddress");
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

  /**
   * Holds the next call of `operation` (recorded, but not yet carried out)
   * until the returned function is called, so a test can act while a slow
   * provider is still working.
   */
  holdNextOperation(operation: FakeSandboxOperation): () => void {
    const { promise, resolve } = Promise.withResolvers<void>();
    this.#heldOperations.set(operation, promise);
    return resolve;
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

  async #beforeOperation(operation: FakeSandboxOperation): Promise<void> {
    const held = this.#heldOperations.get(operation);
    if (held !== undefined) {
      this.#heldOperations.delete(operation);
      await held;
    }
    const planned = this.#plannedFailure;
    if (planned === undefined || (planned.operation ?? operation) !== operation) {
      return;
    }
    this.#plannedFailure = undefined;
    throw planned.error;
  }
}
