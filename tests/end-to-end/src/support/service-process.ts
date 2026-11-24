import { type ChildProcess, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Runs one of Barrack's services from its TypeScript sources, exactly as its
 * entry point runs in production apart from the tsx loader, so the tests
 * need no build of the applications. Its output is kept so that a failing
 * test can show what the service said.
 */

export const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));
export const tsxLoaderUrl = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
const stopTimeoutInMilliseconds = 10_000;
const readyTimeoutInMilliseconds = 20_000;

export type ServiceEntryPoint =
  | "apps/control-plane/src/main.ts"
  | "apps/sandbox-supervisor/src/main.ts";

/** One line of a service's JSON log output, as far as these tests read it. */
export type LogLine = Record<string, unknown>;

export class ServiceProcess {
  readonly #child: ChildProcess;
  readonly #outputLines: string[] = [];
  readonly #lineListeners = new Set<(line: string) => void>();
  readonly #exited: Promise<void>;
  #hasExited = false;

  constructor(entryPoint: ServiceEntryPoint, environment: NodeJS.ProcessEnv) {
    this.#child = spawn(
      process.execPath,
      ["--import", tsxLoaderUrl, `${repositoryRoot}${entryPoint}`],
      { cwd: repositoryRoot, env: environment, stdio: ["ignore", "pipe", "pipe"] },
    );
    this.#exited = new Promise((resolve) => {
      this.#child.once("exit", () => {
        this.#hasExited = true;
        resolve();
      });
    });
    this.#collectLines(this.#child.stdout);
    this.#collectLines(this.#child.stderr);
  }

  /** Resolves with the first JSON log line that matches, failing if the service exits first. */
  waitForLogLine(description: string, matches: (logLine: LogLine) => boolean): Promise<LogLine> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => finish(new Error(`Timed out waiting for ${description}.`)),
        readyTimeoutInMilliseconds,
      );
      const listener = (line: string): void => {
        const logLine = parseLogLine(line);
        if (logLine !== undefined && matches(logLine)) {
          finish(logLine);
        }
      };
      const finish = (outcome: LogLine | Error): void => {
        clearTimeout(timer);
        this.#lineListeners.delete(listener);
        if (outcome instanceof Error) {
          reject(new Error(`${outcome.message}\nService output:\n${this.describeOutput()}`));
          return;
        }
        resolve(outcome);
      };
      this.#lineListeners.add(listener);
      void this.#exited.then(() => finish(new Error(`The service exited before ${description}.`)));
    });
  }

  /** Asks the service to shut down as an operator would, killing it if it does not. */
  async stop(): Promise<void> {
    if (this.#hasExited) {
      return;
    }
    this.#child.kill("SIGTERM");
    const killTimer = setTimeout(() => this.#child.kill("SIGKILL"), stopTimeoutInMilliseconds);
    await this.#exited;
    clearTimeout(killTimer);
  }

  /** Kills the service outright, giving it no chance to clean up. */
  async kill(): Promise<void> {
    if (this.#hasExited) {
      return;
    }
    this.#child.kill("SIGKILL");
    await this.#exited;
  }

  describeOutput(): string {
    return this.#outputLines.join("\n");
  }

  #collectLines(stream: Readable | null): void {
    if (stream === null) {
      return;
    }
    createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY }).on("line", (line) => {
      this.#outputLines.push(line);
      for (const listener of this.#lineListeners) {
        listener(line);
      }
    });
  }
}

function parseLogLine(line: string): LogLine | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    return typeof parsed === "object" && parsed !== null
      ? Object.fromEntries(Object.entries(parsed))
      : undefined;
  } catch {
    // Not every line a service prints is a log line (a startup error, say).
    return undefined;
  }
}
