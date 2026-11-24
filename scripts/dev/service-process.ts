import { type ChildProcess, spawn } from "node:child_process";
import { constants } from "node:os";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

export type ServiceDefinition = {
  /** Printed before every line of the service's output. */
  name: string;
  command: string;
  arguments: string[];
  workingDirectory: string;
  environment: NodeJS.ProcessEnv;
};

export type ServiceExit = { wasSuccessful: boolean; description: string };

/** Wide enough for the longest service name, so the output lines up. */
const nameColumnWidth = "control-plane".length;

/**
 * One service run by `pnpm dev`, as a child process leading a process group
 * of its own. The terminal sends Ctrl-C to its foreground process group, so
 * keeping services out of it lets `pnpm dev` choose the order they stop in.
 * It also means anything a service starts (the control plane starts
 * supervisors, which start Pi) can be killed along with it, and nothing is
 * left behind.
 */
export class ServiceProcess {
  readonly name: string;
  /** Resolves once the service has exited, however that happened. */
  readonly exited: Promise<ServiceExit>;
  readonly #child: ChildProcess;
  #hasExited = false;
  #isStopRequested = false;

  constructor(definition: ServiceDefinition) {
    this.name = definition.name;
    this.#child = spawn(definition.command, definition.arguments, {
      cwd: definition.workingDirectory,
      env: definition.environment,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    this.exited = new Promise((resolve) => {
      this.#child.once("error", (error) => {
        this.#hasExited = true;
        resolve({ wasSuccessful: false, description: `could not be started: ${error.message}` });
      });
      this.#child.once("exit", (exitCode, signal) => {
        this.#hasExited = true;
        this.#killProcessGroup();
        resolve(describeExit(exitCode, signal, this.#isStopRequested));
      });
    });
    this.#relayOutput(this.#child.stdout, process.stdout);
    this.#relayOutput(this.#child.stderr, process.stderr);
  }

  /**
   * Asks the service to shut down with SIGTERM, which every service handles
   * by finishing cleanly, and kills its whole process group if it has not
   * exited within the grace period.
   */
  async stop(gracePeriodInMilliseconds: number): Promise<ServiceExit> {
    if (this.#hasExited) {
      return this.exited;
    }
    this.#isStopRequested = true;
    this.#child.kill("SIGTERM");
    const deadline = setTimeout(() => {
      process.stderr.write(
        `${this.name} did not stop within ${gracePeriodInMilliseconds} ms; killing it.\n`,
      );
      this.#killProcessGroup();
    }, gracePeriodInMilliseconds);
    const exit = await this.exited;
    clearTimeout(deadline);
    return exit;
  }

  /** Kills the service and anything it started that is still running. */
  #killProcessGroup(): void {
    const processGroupId = this.#child.pid;
    if (processGroupId === undefined) {
      return;
    }
    try {
      // A negative process identifier addresses the whole process group.
      process.kill(-processGroupId, "SIGKILL");
    } catch (error) {
      const isGroupAlreadyGone =
        error instanceof Error && "code" in error && error.code === "ESRCH";
      if (!isGroupAlreadyGone) {
        throw error;
      }
    }
  }

  #relayOutput(source: Readable | null, destination: Writable): void {
    if (source === null) {
      return;
    }
    createInterface({ input: source, crlfDelay: Number.POSITIVE_INFINITY }).on("line", (line) => {
      destination.write(labelOutputLine(this.name, line));
    });
  }
}

/** Labels a line of output with who wrote it, so interleaved output stays readable. */
export function labelOutputLine(name: string, line: string): string {
  return `${name.padEnd(nameColumnWidth)} │ ${line}\n`;
}

/**
 * Shells report death by a signal as 128 plus the signal's number, and some
 * services (Vite) exit with that code after handling SIGTERM themselves.
 */
const terminatedBySigtermExitCode = 128 + constants.signals.SIGTERM;

function describeExit(
  exitCode: number | null,
  signal: NodeJS.Signals | null,
  wasStopRequested: boolean,
): ServiceExit {
  if (exitCode === 0) {
    return { wasSuccessful: true, description: "exited cleanly" };
  }
  const endedAsAsked =
    wasStopRequested && (exitCode === terminatedBySigtermExitCode || signal === "SIGTERM");
  if (endedAsAsked) {
    return { wasSuccessful: true, description: "stopped as asked" };
  }
  if (signal !== null) {
    return { wasSuccessful: false, description: `was killed by ${signal}` };
  }
  return { wasSuccessful: false, description: `exited with code ${exitCode}` };
}
