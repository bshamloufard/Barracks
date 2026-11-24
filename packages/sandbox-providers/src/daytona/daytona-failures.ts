import {
  SandboxNotFoundError,
  type SandboxProviderError,
  SandboxProviderUnavailableError,
  SandboxRefusedError,
} from "../sandbox-provider-errors.js";
import { DaytonaApiFailure } from "./daytona-api.js";

/**
 * Turns a failed Daytona call into one of the provider's error types, by the
 * HTTP status Daytona answered with. Timeouts, rate limits and server errors
 * may pass; other client errors (bad requests, rejected credentials,
 * exhausted quotas, conflicts with the sandbox's state) will not until
 * something changes.
 */

const longestQuotedMessageLength = 300;
const passingStatusCodes = new Set([408, 429]);

export function toSandboxProviderError(
  failure: unknown,
  attemptedOperation: string,
  sandboxId?: string,
): SandboxProviderError {
  if (!(failure instanceof DaytonaApiFailure)) {
    const description = failure instanceof Error ? failure.message : String(failure);
    return new SandboxProviderUnavailableError(attemptedOperation, quote(description));
  }
  const explanation = `Daytona said "${quote(failure.message)}"`;
  const { statusCode } = failure;
  if (failure.isTransportFailure || statusCode === undefined) {
    return new SandboxProviderUnavailableError(attemptedOperation, explanation);
  }
  if (statusCode === 404 && sandboxId !== undefined) {
    return new SandboxNotFoundError(attemptedOperation, sandboxId);
  }
  if (passingStatusCodes.has(statusCode) || statusCode >= 500) {
    return new SandboxProviderUnavailableError(attemptedOperation, explanation);
  }
  return new SandboxRefusedError(attemptedOperation, explanation);
}

export function isConflict(failure: unknown): boolean {
  return failure instanceof DaytonaApiFailure && failure.statusCode === 409;
}

function quote(text: string): string {
  return text.length > longestQuotedMessageLength
    ? `${text.slice(0, longestQuotedMessageLength)}…`
    : text;
}
