import { threadIdSchema } from "@barrack/protocol";
import type {
  SandboxCreationRequest,
  SandboxStartOptions,
  ServiceAddressRequest,
} from "./sandbox-provider.js";
import { SandboxRefusedError } from "./sandbox-provider-errors.js";
import { supervisorSecretsDirectoryVariable } from "./supervisor-secrets.js";

/**
 * Checks shared by every provider, so that a request one provider accepts is
 * never refused by another for reasons that have nothing to do with it.
 */

/**
 * A variable's or a secret's name. A secret's is also its file's name, so
 * it is kept within what a tar header holds, and free of dots and slashes.
 */
const settingNamePattern = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;

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
    if (!settingNamePattern.test(name)) {
      throw new SandboxRefusedError(
        attemptedOperation,
        `"${name}" is not a valid environment variable name`,
      );
    }
    if (name === supervisorSecretsDirectoryVariable) {
      throw new SandboxRefusedError(
        attemptedOperation,
        `"${name}" is the provider's to set, since it puts the secrets there`,
      );
    }
    if (Object.hasOwn(request.supervisorSecrets, name)) {
      throw new SandboxRefusedError(
        attemptedOperation,
        `"${name}" is given both as a setting and as a secret`,
      );
    }
  }
  validateSecrets(request.supervisorSecrets, attemptedOperation);
}

export function validateStartOptions(
  options: SandboxStartOptions | undefined,
  attemptedOperation: string,
): void {
  validateSecrets(options?.replacementSecrets ?? {}, attemptedOperation);
}

function validateSecrets(
  secrets: Readonly<Record<string, string>>,
  attemptedOperation: string,
): void {
  for (const [name, value] of Object.entries(secrets)) {
    if (!settingNamePattern.test(name)) {
      throw new SandboxRefusedError(attemptedOperation, `"${name}" is not a valid secret name`);
    }
    if (value.length === 0) {
      throw new SandboxRefusedError(attemptedOperation, `the secret "${name}" is empty`);
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
