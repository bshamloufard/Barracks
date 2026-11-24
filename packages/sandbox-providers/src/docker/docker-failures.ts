import {
  SandboxImageUnavailableError,
  SandboxNotFoundError,
  type SandboxProviderError,
  SandboxProviderUnavailableError,
  SandboxRefusedError,
} from "../sandbox-provider-errors.js";
import { DockerCommandFailure } from "./docker-cli.js";

/**
 * Turns a failed docker command into one of the provider's error types. The
 * CLI reports everything as text on standard error, so this matches the
 * messages the Docker daemon and CLI use; anything unrecognised is treated as
 * a provider that may recover, because retrying it later is the safer guess.
 */

const longestQuotedErrorLength = 500;

const daemonUnreachablePatterns = [
  /cannot connect to the docker daemon/i,
  /error during connect/i,
  /is the docker daemon running/i,
];

const missingContainerPatterns = [/no such container/i, /no such object/i];

/** The configured image cannot be found or pulled. */
const imageUnavailablePatterns = [
  /unable to find image/i,
  /pull access denied/i,
  /manifest unknown/i,
  /no such image/i,
  /repository does not exist/i,
  /error response from daemon: .*not found/i,
];

const refusalPatterns = [
  // The user running Barrack may not use Docker.
  /permission denied while trying to connect/i,
  // Resource limits the host cannot meet, or options it does not accept.
  /no space left on device/i,
  /minimum memory limit/i,
  /range of cpus/i,
  /invalid argument/i,
];

const nameConflictPattern = /is already in use by container/i;

export function isContainerNameConflict(failure: unknown): boolean {
  return failure instanceof DockerCommandFailure && nameConflictPattern.test(failure.standardError);
}

export function isMissingContainer(failure: unknown): boolean {
  return (
    failure instanceof DockerCommandFailure &&
    missingContainerPatterns.some((pattern) => pattern.test(failure.standardError))
  );
}

export function toSandboxProviderError(
  failure: unknown,
  attemptedOperation: string,
  sandboxId?: string,
): SandboxProviderError {
  if (!(failure instanceof DockerCommandFailure)) {
    const description = failure instanceof Error ? failure.message : String(failure);
    return new SandboxProviderUnavailableError(attemptedOperation, quote(description));
  }
  if (failure.reason === "not-installed") {
    return new SandboxProviderUnavailableError(attemptedOperation, "the docker command is missing");
  }
  if (failure.reason === "timed-out") {
    return new SandboxProviderUnavailableError(attemptedOperation, "the docker command timed out");
  }
  if (sandboxId !== undefined && isMissingContainer(failure)) {
    return new SandboxNotFoundError(attemptedOperation, sandboxId);
  }
  const explanation = `docker said "${quote(failure.standardError)}"`;
  if (daemonUnreachablePatterns.some((pattern) => pattern.test(failure.standardError))) {
    return new SandboxProviderUnavailableError(attemptedOperation, explanation);
  }
  if (imageUnavailablePatterns.some((pattern) => pattern.test(failure.standardError))) {
    return new SandboxImageUnavailableError(
      attemptedOperation,
      `the sandbox image cannot be found or pulled; docker said "${quote(failure.standardError)}"`,
    );
  }
  if (refusalPatterns.some((pattern) => pattern.test(failure.standardError))) {
    return new SandboxRefusedError(attemptedOperation, explanation);
  }
  return new SandboxProviderUnavailableError(attemptedOperation, explanation);
}

function quote(text: string): string {
  const firstLine = text.split("\n", 1)[0] ?? "";
  return firstLine.length > longestQuotedErrorLength
    ? `${firstLine.slice(0, longestQuotedErrorLength)}…`
    : firstLine;
}
