import { threadIdSchema } from "@barrack/protocol";
import type { SandboxCreationRequest, ServiceAddressRequest } from "./sandbox-provider.js";
import { SandboxRefusedError } from "./sandbox-provider-errors.js";

/**
 * Checks shared by every provider, so that a request one provider accepts is
 * never refused by another for reasons that have nothing to do with it.
 */

const environmentVariableNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function describeSandboxCreation(threadId: string): string {
  return `create a sandbox for thread "${threadId}"`;
}

/** Throws `SandboxRefusedError` naming the first problem. Values are never echoed. */
export function validateCreationRequest(request: SandboxCreationRequest): void {
  const attemptedOperation = describeSandboxCreation(request.threadId);
  if (!threadIdSchema.safeParse(request.threadId).success) {
    throw new SandboxRefusedError(attemptedOperation, "the thread identifier is not valid");
  }
  for (const name of Object.keys(request.supervisorEnvironment)) {
    if (!environmentVariableNamePattern.test(name)) {
      throw new SandboxRefusedError(
        attemptedOperation,
        `"${name}" is not a valid environment variable name`,
      );
    }
  }
}

export function validateServiceAddressRequest(request: ServiceAddressRequest): void {
  const attemptedOperation = describeServiceAddressLookup(request);
  const isPort = Number.isInteger(request.port) && request.port >= 1 && request.port <= 65_535;
  if (!isPort) {
    throw new SandboxRefusedError(attemptedOperation, "the port must be between 1 and 65535");
  }
  if (!Number.isInteger(request.validForSeconds) || request.validForSeconds < 1) {
    throw new SandboxRefusedError(
      attemptedOperation,
      "the validity must be a whole number of seconds, at least 1",
    );
  }
}

export function describeServiceAddressLookup(request: ServiceAddressRequest): string {
  return `get an address for port ${request.port} of sandbox "${request.sandboxId}"`;
}
