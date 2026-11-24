import { spawn } from "node:child_process";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import {
  type ApplicableLimits,
  buildLimitingScript,
  findExceededLimit,
  type GitChildLimits,
  type LimitedResource,
} from "./git-child-limits.js";

/** More than any command here prints; `ls-remote` of one branch prints one line. */
const maximumOutputInBytes = 1024 * 1024;
/** Git's last words are enough to say why it failed. */
const maximumErrorOutputInBytes = 64 * 1024;
/** How often the publication directory is measured while Git runs. */
const diskCheckIntervalInMilliseconds = 200;

export type LimitedGitCommand = {
  gitArguments: string[];
  workingDirectory: string;
  environment: NodeJS.ProcessEnv;
  /** Piped to Git's standard input, when given. */
  input?: Readable;
  /** The directory whose total size is limited: the publication's own. */
  scratchDirectory: string;
  limits: GitChildLimits;
  applicable: ApplicableLimits;
};

export type LimitedGitOutcome =
  | { kind: "succeeded"; standardOutput: string }
  | { kind: "failed"; exitCode: number | null; standardOutput: string; standardError: string }
  | { kind: "limit_exceeded"; resource: LimitedResource; standardError: string };

/**
 * Runs one Git command under the publication's limits (see
 * `GitChildLimits`): the kernel's per-process limits, set by the shell
 * before it becomes Git and inherited by every process Git starts, and the
 * control plane's own wall-time and disk limits, which it enforces by
 * killing Git's whole process group. Git runs in a group of its own for
 * that, so a process it started (`index-pack`, `git-remote-https`) does not
 * outlive it.
 */
export function runLimitedGit(command: LimitedGitCommand): Promise<LimitedGitOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "/bin/sh",
      [
        "-c",
        buildLimitingScript(command.limits, command.applicable),
        "barrack-git",
        ...command.gitArguments,
      ],
      {
        cwd: command.workingDirectory,
        env: command.environment,
        stdio: [command.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        detached: true,
      },
    );
    let stoppedFor: StopCause | undefined;
    const killGroup = (cause: StopCause) => {
      stoppedFor ??= cause;
      if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // The group had already gone.
      }
    };
    const wallTimer = setTimeout(
      () => killGroup("wall_time"),
      command.limits.wallTimeInMilliseconds,
    );
    const stopWatchingDisk = watchDisk(command, () => killGroup("disk"));
    const standardOutput = collect(child.stdout, maximumOutputInBytes, () => killGroup("output"));
    const standardError = collect(child.stderr, maximumErrorOutputInBytes);
    let inputError: Error | undefined;
    if (command.input !== undefined && child.stdin !== null) {
      command.input.on("error", (error) => {
        inputError = error;
        killGroup("input");
      });
      // Git stops reading as soon as it refuses its input, and writing on
      // then fails with EPIPE; its exit status says why.
      child.stdin.on("error", () => undefined);
      command.input.pipe(child.stdin);
    }
    child.on("error", (error) => {
      clearTimeout(wallTimer);
      stopWatchingDisk();
      reject(error);
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(wallTimer);
      stopWatchingDisk();
      if (stoppedFor === "input") {
        reject(inputError);
        return;
      }
      resolve(
        decideOutcome({
          stoppedFor,
          exitCode,
          signal,
          standardOutput: standardOutput.text(),
          standardError: standardError.text(),
        }),
      );
    });
  });
}

/** Why the control plane killed Git: one of its own limits, or what it was given or printed. */
type StopCause = LimitedResource | "output" | "input";

function decideOutcome(ending: {
  stoppedFor: Exclude<StopCause, "input"> | undefined;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  standardOutput: string;
  standardError: string;
}): LimitedGitOutcome {
  if (ending.stoppedFor === "output") {
    return {
      kind: "failed",
      exitCode: null,
      standardOutput: "",
      standardError: "Git printed far more than expected.",
    };
  }
  const exceeded = ending.stoppedFor ?? findExceededLimit(ending.signal, ending.standardError);
  if (exceeded !== undefined) {
    return { kind: "limit_exceeded", resource: exceeded, standardError: ending.standardError };
  }
  return ending.exitCode === 0
    ? { kind: "succeeded", standardOutput: ending.standardOutput }
    : {
        kind: "failed",
        exitCode: ending.exitCode,
        standardOutput: ending.standardOutput,
        standardError: ending.standardError,
      };
}

/** Keeps at most `maximumBytes` of a stream; past that, keeps the end, or calls `onOverflow`. */
function collect(
  stream: Readable | null,
  maximumBytes: number,
  onOverflow?: () => void,
): { text: () => string } {
  let chunks: Buffer[] = [];
  let length = 0;
  stream?.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
    length += chunk.length;
    if (length <= maximumBytes) {
      return;
    }
    if (onOverflow !== undefined) {
      onOverflow();
      return;
    }
    const kept = Buffer.concat(chunks).subarray(-maximumBytes);
    chunks = [kept];
    length = kept.length;
  });
  return { text: () => Buffer.concat(chunks).toString() };
}

/**
 * Measures the publication directory every few hundred milliseconds and
 * calls `onExceeded` once it is larger than allowed. Between measurements
 * Git may write a little more; the per-file limit bounds that too.
 */
function watchDisk(command: LimitedGitCommand, onExceeded: () => void): () => void {
  let isMeasuring = false;
  const timer = setInterval(() => {
    if (isMeasuring) {
      return;
    }
    isMeasuring = true;
    measureDirectory(command.scratchDirectory)
      .then((sizeInBytes) => {
        if (sizeInBytes > command.limits.diskInBytes) {
          onExceeded();
        }
      })
      // A file Git removed between listing and measuring is not an error.
      .catch(() => undefined)
      .finally(() => {
        isMeasuring = false;
      });
  }, diskCheckIntervalInMilliseconds);
  return () => clearInterval(timer);
}

async function measureDirectory(directory: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      total += await measureDirectory(entryPath).catch(() => 0);
    } else {
      total += await lstat(entryPath).then(
        (stats) => stats.size,
        () => 0,
      );
    }
  }
  return total;
}
