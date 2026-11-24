import { type Logger, pino } from "pino";
import type { LogLevel } from "./configuration.js";

export type { Logger };

/**
 * One JSON object per line on stdout. Every line carries the thread, so the
 * life of a thread can be traced from the supervisor's output alone.
 *
 * Secrets are kept out by never passing them to the logger. The redaction
 * list is a second line of defence in case a credential-shaped field is
 * logged by mistake.
 */
export function createLogger(level: LogLevel, threadId: string): Logger {
  return pino({
    level,
    base: { service: "sandbox-supervisor", threadId },
    redact: {
      paths: ["token", "supervisorToken", "authorization", "apiKey", "*.token", "*.authorization"],
      censor: "[redacted]",
    },
  });
}
