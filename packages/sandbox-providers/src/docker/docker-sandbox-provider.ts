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
  SandboxProviderError,
  SandboxRefusedError,
} from "../sandbox-provider-errors.js";
import { createDockerCommandRunner, type DockerCommandRunner } from "./docker-cli.js";
import {
  type InspectedContainer,
  isBarrackSandbox,
  isContainerId,
  parseInspectedContainer,
  toSandboxStatus,
} from "./docker-container.js";
import {
  isContainerNameConflict,
  isMissingContainer,
  toSandboxProviderError,
} from "./docker-failures.js";
import {
  buildRunArguments,
  containerNameFor,
  type DockerProviderSettings,
  isReservedForDockerCli,
} from "./docker-run-arguments.js";

/**
 * One Docker container per thread, on a machine Barrack controls. The
 * container's main process is the supervisor (the image's default command),
 * so whenever the container runs, the supervisor runs, with the environment
 * the container was created with; stopping the container keeps its files and
 * starting it runs the supervisor again.
 *
 * A sandbox's identifier is its container's full 64-character ID, which is
 * never reused, so a stored identifier cannot come to mean a container made
 * later for the same thread. Every operation checks that the container is
 * labelled as a Barrack sandbox first, so a caller can never stop or remove
 * an unrelated container by naming it.
 */

/** Creating may pull the image first, which can take minutes on a slow link. */
const createTimeoutInMilliseconds = 10 * 60 * 1000;
const quickCommandTimeoutInMilliseconds = 60 * 1000;

export class DockerSandboxProvider implements SandboxProvider {
  readonly #settings: DockerProviderSettings;
  readonly #docker: DockerCommandRunner;

  constructor(settings: DockerProviderSettings, docker?: DockerCommandRunner) {
    this.#settings = settings;
    this.#docker = docker ?? createDockerCommandRunner(settings.dockerExecutable);
  }

  async create(request: SandboxCreationRequest): Promise<CreatedSandbox> {
    validateCreationRequest(request);
    const attemptedOperation = describeSandboxCreation(request.threadId);
    const reservedName = Object.keys(request.supervisorEnvironment).find(isReservedForDockerCli);
    if (reservedName !== undefined) {
      throw new SandboxRefusedError(
        attemptedOperation,
        `"${reservedName}" is reserved for the docker command itself`,
      );
    }
    try {
      const output = await this.#docker(buildRunArguments(this.#settings, request), {
        extraEnvironment: request.supervisorEnvironment,
        timeoutInMilliseconds: createTimeoutInMilliseconds,
      });
      return { sandboxId: output.trim() };
    } catch (failure) {
      if (isContainerNameConflict(failure)) {
        throw await this.#describeExistingSandbox(request.threadId, attemptedOperation);
      }
      throw await this.#removeHalfCreatedContainer(
        request.threadId,
        toSandboxProviderError(failure, attemptedOperation),
      );
    }
  }

  async start(sandboxId: string): Promise<void> {
    const attemptedOperation = `start sandbox "${sandboxId}"`;
    await this.#requireSandbox(sandboxId, attemptedOperation);
    // Starting a running container succeeds without doing anything.
    await this.#runOnSandbox(["container", "start", sandboxId], attemptedOperation, sandboxId);
  }

  async stop(sandboxId: string): Promise<void> {
    const attemptedOperation = `stop sandbox "${sandboxId}"`;
    await this.#requireSandbox(sandboxId, attemptedOperation);
    // Stopping a stopped container succeeds without doing anything. The
    // container's own stop timeout, set when it was created, applies.
    await this.#runOnSandbox(["container", "stop", sandboxId], attemptedOperation, sandboxId, {
      timeoutInMilliseconds:
        quickCommandTimeoutInMilliseconds + this.#settings.stopTimeoutInSeconds * 1000,
    });
  }

  async destroy(sandboxId: string): Promise<void> {
    const attemptedOperation = `destroy sandbox "${sandboxId}"`;
    if ((await this.#inspectSandbox(sandboxId, attemptedOperation)) === undefined) {
      return;
    }
    try {
      await this.#docker(["container", "rm", "--force", "--volumes", sandboxId], {
        timeoutInMilliseconds: quickCommandTimeoutInMilliseconds,
      });
    } catch (failure) {
      if (isMissingContainer(failure)) {
        return;
      }
      throw toSandboxProviderError(failure, attemptedOperation, sandboxId);
    }
  }

  async getStatus(sandboxId: string): Promise<SandboxStatus> {
    const container = await this.#inspectSandbox(sandboxId, `read the state of "${sandboxId}"`);
    return container === undefined ? { state: "missing" } : toSandboxStatus(container);
  }

  async getServiceAddress(request: ServiceAddressRequest): Promise<ServiceAddress> {
    validateServiceAddressRequest(request);
    const attemptedOperation = describeServiceAddressLookup(request);
    await this.#requireSandbox(request.sandboxId, attemptedOperation);
    if (!this.#settings.servicePorts.includes(request.port)) {
      throw new SandboxRefusedError(
        attemptedOperation,
        "the port is not among the Docker provider's configured service ports",
      );
    }
    const output = await this.#runOnSandbox(
      ["container", "port", request.sandboxId, `${request.port}/tcp`],
      attemptedOperation,
      request.sandboxId,
    );
    const hostAddress = output.split("\n").find((line) => line.startsWith("127.0.0.1:"));
    if (hostAddress === undefined) {
      throw new SandboxRefusedError(attemptedOperation, "the sandbox is not running");
    }
    return {
      url: `http://${hostAddress}/`,
      expiresAt: undefined,
      reachableBy: "the-sandbox-host-only",
    };
  }

  async #describeExistingSandbox(
    threadId: string,
    attemptedOperation: string,
  ): Promise<SandboxAlreadyExistsError | SandboxRefusedError> {
    const existing = await this.#inspect(containerNameFor(threadId), attemptedOperation);
    if (existing === undefined || !isBarrackSandbox(existing)) {
      return new SandboxRefusedError(
        attemptedOperation,
        `a container that is not a Barrack sandbox is already named "${containerNameFor(threadId)}"`,
      );
    }
    return new SandboxAlreadyExistsError(threadId, existing.Id);
  }

  /**
   * `docker run` creates the container before starting it, so a run that
   * fails to start (an impossible resource limit, say) leaves a container
   * behind that would make every retry for the thread fail as a duplicate.
   * Returns the error to throw: the create's own failure, or, if removing the
   * container failed too, both failures and the container left behind.
   */
  async #removeHalfCreatedContainer(
    threadId: string,
    creationFailure: SandboxProviderError,
  ): Promise<SandboxProviderError> {
    const containerName = containerNameFor(threadId);
    const attemptedOperation = `remove the half-created container "${containerName}"`;
    try {
      const leftover = await this.#inspect(containerName, attemptedOperation);
      if (leftover !== undefined && isBarrackSandbox(leftover)) {
        await this.#docker(["container", "rm", "--force", "--volumes", leftover.Id], {
          timeoutInMilliseconds: quickCommandTimeoutInMilliseconds,
        });
      }
      return creationFailure;
    } catch (removalFailure) {
      if (isMissingContainer(removalFailure)) {
        return creationFailure;
      }
      // `#inspect` reports its own failures as provider errors already.
      const removalError =
        removalFailure instanceof SandboxProviderError
          ? removalFailure
          : toSandboxProviderError(removalFailure, attemptedOperation);
      return describeFailedUndo(
        creationFailure,
        removalError,
        `container "${containerName}" is left behind and must be removed by hand before the thread can have another`,
      );
    }
  }

  async #requireSandbox(sandboxId: string, attemptedOperation: string): Promise<void> {
    if ((await this.#inspectSandbox(sandboxId, attemptedOperation)) === undefined) {
      throw new SandboxNotFoundError(attemptedOperation, sandboxId);
    }
  }

  /** The container, if `sandboxId` is the full ID of one of Barrack's sandboxes. */
  async #inspectSandbox(
    sandboxId: string,
    attemptedOperation: string,
  ): Promise<InspectedContainer | undefined> {
    if (!isContainerId(sandboxId)) {
      return undefined;
    }
    const container = await this.#inspect(sandboxId, attemptedOperation);
    const isSameSandbox =
      container !== undefined && container.Id === sandboxId && isBarrackSandbox(container);
    return isSameSandbox ? container : undefined;
  }

  async #inspect(
    containerReference: string,
    attemptedOperation: string,
  ): Promise<InspectedContainer | undefined> {
    try {
      const output = await this.#docker(
        ["container", "inspect", "--format", "{{json .}}", containerReference],
        { timeoutInMilliseconds: quickCommandTimeoutInMilliseconds },
      );
      return parseInspectedContainer(output);
    } catch (failure) {
      if (isMissingContainer(failure)) {
        return undefined;
      }
      throw toSandboxProviderError(failure, attemptedOperation);
    }
  }

  async #runOnSandbox(
    commandArguments: string[],
    attemptedOperation: string,
    sandboxId: string,
    options = { timeoutInMilliseconds: quickCommandTimeoutInMilliseconds },
  ): Promise<string> {
    try {
      return await this.#docker(commandArguments, options);
    } catch (failure) {
      throw toSandboxProviderError(failure, attemptedOperation, sandboxId);
    }
  }
}
