import { execFile } from "node:child_process";

/**
 * Runs the `docker` command-line client. Barrack talks to Docker through its
 * CLI rather than a client library: the CLI is already installed wherever
 * Docker is, honours the operator's contexts, `DOCKER_HOST` and credential
 * helpers, and its commands are the ones an operator would type to look at
 * the same containers.
 *
 * Arguments are passed as an array, never through a shell. Values that must
 * stay secret are passed in the CLI's own environment, never as arguments,
 * because a process's arguments are visible to every user on the machine.
 */

export type DockerCommandOptions = {
  /** Variables added to the CLI's environment, e.g. for `--env NAME` to read. */
  extraEnvironment?: Readonly<Record<string, string>>;
  /** Written to the command's standard input. */
  standardInput?: string;
  timeoutInMilliseconds: number;
};

/** A docker command that could not run or exited with an error. */
export class DockerCommandFailure extends Error {
  readonly reason: "not-installed" | "timed-out" | "exited-with-error";
  /** What the CLI printed on standard error, trimmed. */
  readonly standardError: string;

  constructor(reason: DockerCommandFailure["reason"], standardError: string) {
    super(`docker ${reason}: ${standardError}`);
    this.name = "DockerCommandFailure";
    this.reason = reason;
    this.standardError = standardError;
  }
}

export type DockerCommandRunner = (
  commandArguments: readonly string[],
  options: DockerCommandOptions,
) => Promise<string>;

const maximumOutputInBytes = 16 * 1024 * 1024;

/** Returns a runner for the given docker executable, which resolves with standard output. */
export function createDockerCommandRunner(dockerExecutable: string): DockerCommandRunner {
  return (commandArguments, options) =>
    new Promise((resolve, reject) => {
      const child = execFile(
        dockerExecutable,
        [...commandArguments],
        {
          env: { ...process.env, ...options.extraEnvironment },
          timeout: options.timeoutInMilliseconds,
          maxBuffer: maximumOutputInBytes,
          encoding: "utf8",
        },
        (error, standardOutput, standardError) => {
          if (error === null) {
            resolve(standardOutput);
            return;
          }
          reject(toDockerCommandFailure(error, standardError.trim()));
        },
      );
      child.stdin?.end(options.standardInput ?? "");
    });
}

type ExecFileError = Error & { code?: unknown; killed?: boolean };

function toDockerCommandFailure(error: ExecFileError, standardError: string): DockerCommandFailure {
  if (error.code === "ENOENT") {
    return new DockerCommandFailure("not-installed", "the docker command was not found");
  }
  if (error.killed === true) {
    return new DockerCommandFailure("timed-out", standardError);
  }
  return new DockerCommandFailure("exited-with-error", standardError);
}
