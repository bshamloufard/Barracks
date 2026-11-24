import { type DestinationStream, type Logger, pino } from "pino";
import type { LogLevel } from "./configuration.js";
import type { SecretRedactor } from "./secret-redactor.js";

export type { Logger };

/**
 * One JSON object per line on stdout. Every line carries the thread, so the
 * life of a thread can be traced from the supervisor's output alone.
 *
 * Secrets are kept out by never passing them to the logger. Two lines of
 * defence back that up: the redaction list, in case a credential-shaped
 * field is logged by mistake, and every finished line passing through
 * `secretRedactor`, which replaces any model credential this supervisor
 * holds wherever it appears (in a diagnostic Pi printed, say).
 */
export function createLogger(
  level: LogLevel,
  threadId: string,
  secretRedactor: SecretRedactor,
  destination?: DestinationStream,
): Logger {
  const options = {
    level,
    base: { service: "sandbox-supervisor", threadId },
    redact: {
      paths: [
        "token",
        "supervisorToken",
        "authorization",
        "apiKey",
        "secret",
        "credential",
        "*.token",
        "*.authorization",
        "*.secret",
        "*.credential",
      ],
      censor: "[redacted]",
    },
    hooks: { streamWrite: (line: string) => secretRedactor.redactText(line) },
  };
  return destination === undefined ? pino(options) : pino(options, destination);
}
