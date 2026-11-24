import { type Logger, pino } from "pino";
import type { LogLevel } from "./configuration.js";

export type { Logger };

/**
 * Structured JSON logs on standard output, one object per line. Code that
 * acts on a thread logs through a child of this logger that carries the
 * thread's identifier, so one thread's life can be followed by filtering on
 * `threadId`. Message content and credentials are never logged.
 */
export function createLogger(level: LogLevel): Logger {
  return pino({ level, base: { service: "control-plane" } });
}
