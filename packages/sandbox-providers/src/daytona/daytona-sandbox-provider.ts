import {
  describeSandboxCreation,
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
  describeFailedUndo,
  SandboxAlreadyExistsError,
  SandboxNotFoundError,
  type SandboxProviderError,
  SandboxProviderUnavailableError,
  SandboxRefusedError,
} from "../sandbox-provider-errors.js";
import type { DaytonaApi, DaytonaCreationParameters, DaytonaSandboxRecord } from "./daytona-api.js";
import { isConflict, toSandboxProviderError } from "./daytona-failures.js";
import { toSandboxStatus } from "./daytona-states.js";

export type DaytonaProviderSettings = {
  /** The Daytona snapshot registered from Barrack's sandbox image (see `sandbox-image/README.md`). */
  snapshot: string;
  /** The Daytona region to create sandboxes in; the organisation's default when undefined. */
  target: string | undefined;
  /**
   * Minutes after a sandbox stops before Daytona archives it. A stopped
   * sandbox still occupies, and is billed for, its disk, and on the lower
   * tiers that disk also counts against a small storage quota that would
   * soon stop new sandboxes being created. Archiving moves the files to
   * object storage, which is free, at the price of a slower start. The
   * default of an hour keeps a thread the user comes straight back to quick
   * to resume and stops a forgotten one costing anything within the hour.
   * https://www.daytona.io/docs/en/sandboxes#auto-archive-interval
   * https://www.daytona.io/docs/en/billing
   */
  autoArchiveIntervalInMinutes: number;
};

/**
 * Daytona stops a sandbox after 15 idle minutes by default, and it counts
 * only interaction from outside (API calls, previews, SSH) as activity, not
 * an agent working inside, so it would stop an agent mid-task. Zero turns
 * the timer off; the control plane decides when a sandbox stops.
 * https://www.daytona.io/docs/en/sandboxes#auto-stop-interval
 */
const autoStopDisabled = 0;
/** Daytona never deletes a sandbox by itself; the control plane destroys it. */
const autoDeleteDisabled = -1;

/** Daytona allows a signed preview URL to live at most a day. https://www.daytona.io/docs/en/preview */
const longestSignedPreviewUrlLifetimeInSeconds = 86_400;

/** Starting an archived sandbox restores its files from object storage, which can take minutes. */
const startTimeoutInSeconds = 600;
const createTimeoutInSeconds = 300;
const stopTimeoutInSeconds = 120;
const deleteTimeoutInSeconds = 120;
const launchSupervisorTimeoutInSeconds = 60;

/**
 * Starts the supervisor unless it is already running; it is in the sandbox
 * image and is safe to run any number of times. Daytona decides for itself
 * what a sandbox's first process is, so the provider runs this after every
 * create and every start instead of relying on the image's default command.
 */
const ensureSupervisorCommand = "/usr/local/bin/barrack-ensure-supervisor";

export const sandboxLabel = "barrack.sandbox";
export const threadIdLabel = "barrack.thread-id";

export function sandboxNameFor(threadId: string): string {
  return `barrack-thread-${threadId}`;
}

export class DaytonaSandboxProvider implements SandboxProvider {
  readonly #settings: DaytonaProviderSettings;
  readonly #daytona: DaytonaApi;
  readonly #now: () => Date;

  constructor(settings: DaytonaProviderSettings, daytona: DaytonaApi, now = () => new Date()) {
    this.#settings = settings;
    this.#daytona = daytona;
    this.#now = now;
  }

  async create(request: SandboxCreationRequest): Promise<CreatedSandbox> {
    validateCreationRequest(request);
    const attemptedOperation = describeSandboxCreation(request.threadId);
    await this.#refuseIfThreadHasSandbox(request.threadId, attemptedOperation);
    let created: DaytonaSandboxRecord;
    try {
      created = await this.#daytona.createSandbox(
        this.#creationParameters(request),
        createTimeoutInSeconds,
      );
    } catch (failure) {
      if (isConflict(failure)) {
        await this.#refuseIfThreadHasSandbox(request.threadId, attemptedOperation);
      }
      throw toSandboxProviderError(failure, attemptedOperation);
    }
    const launchFailure = await this.#tryToLaunchSupervisor(created, attemptedOperation);
    if (launchFailure !== undefined) {
      // Auto-stop and auto-delete are off, so nothing else would ever remove
      // it: it would run, and be billed, with no supervisor, and a retry
      // would be told that the thread already has it.
      throw await this.#undo(launchFailure, {
        attemptedOperation: `delete sandbox "${created.id}"`,
        sandboxId: created.id,
        undoneBy: () => this.#daytona.deleteSandbox(created.id, deleteTimeoutInSeconds),
        consequence: `sandbox "${created.id}" is left behind and must be deleted by hand before the thread can have another`,
      });
    }
    return { sandboxId: created.id };
  }

  async start(sandboxId: string): Promise<void> {
    const attemptedOperation = `start sandbox "${sandboxId}"`;
    const sandbox = await this.#requireSandbox(sandboxId, attemptedOperation);
    const { state } = toSandboxStatus(sandbox);
    if (state === "stopping") {
      throw new SandboxProviderUnavailableError(attemptedOperation, "it is still stopping");
    }
    await this.#call(attemptedOperation, sandboxId, async () => {
      if (state === "starting") {
        await this.#daytona.waitUntilStarted(sandboxId, startTimeoutInSeconds);
      } else if (state !== "running") {
        await this.#daytona.startSandbox(sandboxId, startTimeoutInSeconds);
      }
    });
    // Even a sandbox that was already running gets this, so a start repairs
    // a sandbox whose supervisor could not be launched before.
    const launchFailure = await this.#tryToLaunchSupervisor(sandbox, attemptedOperation);
    if (launchFailure !== undefined) {
      // A running sandbox is one whose supervisor runs, so one without it is
      // stopped again rather than reported as running, and billed, while it
      // does nothing.
      throw await this.#undo(launchFailure, {
        attemptedOperation: `stop sandbox "${sandboxId}"`,
        sandboxId,
        undoneBy: () => this.#daytona.stopSandbox(sandboxId, stopTimeoutInSeconds),
        consequence: `sandbox "${sandboxId}" may be running without its supervisor until it is stopped by hand`,
      });
    }
  }

  async stop(sandboxId: string): Promise<void> {
    const attemptedOperation = `stop sandbox "${sandboxId}"`;
    const sandbox = await this.#requireSandbox(sandboxId, attemptedOperation);
    const { state } = toSandboxStatus(sandbox);
    await this.#call(attemptedOperation, sandboxId, async () => {
      if (state === "stopping") {
        await this.#daytona.waitUntilStopped(sandboxId, stopTimeoutInSeconds);
      } else if (state === "running" || state === "starting") {
        await this.#daytona.stopSandbox(sandboxId, stopTimeoutInSeconds);
      }
    });
  }

  async destroy(sandboxId: string): Promise<void> {
    const attemptedOperation = `destroy sandbox "${sandboxId}"`;
    const sandbox = await this.#findSandbox(sandboxId, attemptedOperation);
    if (sandbox === undefined) {
      return;
    }
    try {
      await this.#daytona.deleteSandbox(sandboxId, deleteTimeoutInSeconds);
    } catch (failure) {
      const providerError = toSandboxProviderError(failure, attemptedOperation, sandboxId);
      if (!(providerError instanceof SandboxNotFoundError)) {
        throw providerError;
      }
    }
  }

  async getStatus(sandboxId: string): Promise<SandboxStatus> {
    return toSandboxStatus(
      await this.#findSandbox(sandboxId, `read the state of sandbox "${sandboxId}"`),
    );
  }

  /**
   * A signed preview URL: its token is part of the URL, it opens this one
   * port only, and it stops working when it expires. The standard preview
   * link is never used, because its token opens every port of the sandbox,
   * including Daytona's own terminal and toolbox, and cannot be revoked.
   * https://www.daytona.io/docs/en/preview
   */
  async getServiceAddress(request: ServiceAddressRequest): Promise<ServiceAddress> {
    validateServiceAddressRequest(request);
    const attemptedOperation = describeServiceAddressLookup(request);
    await this.#requireSandbox(request.sandboxId, attemptedOperation);
    const lifetimeInSeconds = Math.min(
      request.validForSeconds,
      longestSignedPreviewUrlLifetimeInSeconds,
    );
    // Taken before the request, so the reported expiry is never later than the real one.
    const expiresAt = new Date(this.#now().getTime() + lifetimeInSeconds * 1000);
    const signed = await this.#call(attemptedOperation, request.sandboxId, () =>
      this.#daytona.createSignedPreviewUrl(request.sandboxId, request.port, lifetimeInSeconds),
    );
    return { url: signed.url, expiresAt, reachableBy: "anyone-with-the-url" };
  }

  #creationParameters(request: SandboxCreationRequest): DaytonaCreationParameters {
    return {
      name: sandboxNameFor(request.threadId),
      snapshot: this.#settings.snapshot,
      envVars: { ...request.supervisorEnvironment },
      labels: { [sandboxLabel]: "true", [threadIdLabel]: request.threadId },
      // Preview URLs of a public sandbox need no token at all.
      public: false,
      autoStopInterval: autoStopDisabled,
      autoArchiveInterval: this.#settings.autoArchiveIntervalInMinutes,
      autoDeleteInterval: autoDeleteDisabled,
      ...(this.#settings.target === undefined ? {} : { target: this.#settings.target }),
    };
  }

  async #refuseIfThreadHasSandbox(threadId: string, attemptedOperation: string): Promise<void> {
    const existing = await this.#findSandbox(sandboxNameFor(threadId), attemptedOperation);
    if (existing !== undefined) {
      throw new SandboxAlreadyExistsError(threadId, existing.id);
    }
  }

  /** Why the supervisor could not be launched, or `undefined` once it has been. */
  async #tryToLaunchSupervisor(
    sandbox: DaytonaSandboxRecord,
    attemptedOperation: string,
  ): Promise<SandboxProviderError | undefined> {
    let exitCode: number;
    try {
      // The command gets the sandbox's environment explicitly as well, in case
      // Daytona does not pass the sandbox's variables to commands it runs.
      const result = await this.#daytona.executeCommand(
        sandbox.id,
        ensureSupervisorCommand,
        sandbox.environment,
        launchSupervisorTimeoutInSeconds,
      );
      exitCode = result.exitCode;
    } catch (failure) {
      return toSandboxProviderError(failure, attemptedOperation, sandbox.id);
    }
    if (exitCode === 0) {
      return undefined;
    }
    return new SandboxRefusedError(
      attemptedOperation,
      `the sandbox could not launch its supervisor (exit code ${exitCode}); check that the snapshot was made from Barrack's sandbox image`,
    );
  }

  /**
   * Undoes what a failed operation did to a sandbox, and returns the error to
   * throw: the operation's own failure, or, if undoing it failed too, both
   * failures and what was left behind.
   */
  async #undo(
    failure: SandboxProviderError,
    undo: {
      attemptedOperation: string;
      sandboxId: string;
      undoneBy: () => Promise<void>;
      consequence: string;
    },
  ): Promise<SandboxProviderError> {
    try {
      await undo.undoneBy();
      return failure;
    } catch (undoFailure) {
      const undoError = toSandboxProviderError(
        undoFailure,
        undo.attemptedOperation,
        undo.sandboxId,
      );
      // A sandbox that is gone is neither billed nor running.
      if (undoError instanceof SandboxNotFoundError) {
        return failure;
      }
      return describeFailedUndo(failure, undoError, undo.consequence);
    }
  }

  async #requireSandbox(
    sandboxId: string,
    attemptedOperation: string,
  ): Promise<DaytonaSandboxRecord> {
    const sandbox = await this.#findSandbox(sandboxId, attemptedOperation);
    if (sandbox === undefined) {
      throw new SandboxNotFoundError(attemptedOperation, sandboxId);
    }
    return sandbox;
  }

  /**
   * The sandbox, if it exists and is one of Barrack's, so a caller can never
   * act on some other sandbox in the same Daytona organisation by naming it.
   */
  async #findSandbox(
    sandboxIdOrName: string,
    attemptedOperation: string,
  ): Promise<DaytonaSandboxRecord | undefined> {
    const sandbox = await this.#call(attemptedOperation, undefined, () =>
      this.#daytona.findSandbox(sandboxIdOrName),
    );
    const isBarrackSandbox = sandbox !== undefined && sandbox.labels[sandboxLabel] === "true";
    if (!isBarrackSandbox || toSandboxStatus(sandbox).state === "missing") {
      return undefined;
    }
    return sandbox;
  }

  async #call<Result>(
    attemptedOperation: string,
    sandboxId: string | undefined,
    call: () => Promise<Result>,
  ): Promise<Result> {
    try {
      return await call();
    } catch (failure) {
      throw toSandboxProviderError(failure, attemptedOperation, sandboxId);
    }
  }
}
