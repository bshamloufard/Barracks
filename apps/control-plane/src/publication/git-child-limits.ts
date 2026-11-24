import { spawnSync } from "node:child_process";

/**
 * What every Git process the control plane runs on a publication may use.
 * Each publication reads a bundle a sandbox made and a repository a user
 * chose, both untrusted, with the control plane's own memory, processor and
 * disk; without bounds one hostile bundle could take the control plane, and
 * every thread with it, down. A pack of 16 KB holding a delta that declares
 * a 2 GiB result made `index-pack` hold 2 GiB, for example.
 *
 * The limits are chosen for the largest publication Barrack supports (a
 * bundle of 100 MB) with room to spare, and far below what the smallest
 * Railway instance has:
 *
 * - **address space, 1 GiB per process**: Git, with one thread and its pack
 *   windows kept small (see `boundedGitSettings`), needs the largest object
 *   it rebuilds twice over plus a few tens of megabytes. A file of a few
 *   hundred megabytes still publishes; a delta declaring more fails at once,
 *   before anything is allocated.
 * - **processor time, 120 s per process**: indexing and checking a 100 MB
 *   pack takes seconds, and fetching the history of a large repository's
 *   base branch well under a minute.
 * - **wall time, 300 s per command**: covers a slow network.
 * - **disk, 2 GiB for the publication's directory**, and the same for any
 *   one file: the bundle, its pack indexed twice (by the check and by the
 *   fetch), and the base branch's history without file contents.
 *
 * A limit being hit fails the publication with a message saying which; it
 * never stops the control plane.
 */
export type GitChildLimits = {
  addressSpaceInBytes: number;
  processorSeconds: number;
  wallTimeInMilliseconds: number;
  /** Both the largest file any Git process may write and the publication directory's total. */
  diskInBytes: number;
};

export const defaultGitChildLimits: GitChildLimits = {
  addressSpaceInBytes: 1024 * 1024 * 1024,
  processorSeconds: 120,
  wallTimeInMilliseconds: 300_000,
  diskInBytes: 2 * 1024 * 1024 * 1024,
};

/**
 * Git settings that keep its memory within the address-space limit for
 * honest input: one thread (each thread and its allocator arena reserve
 * address space), pack files mapped in small windows rather than whole,
 * and blobs larger than 64 MiB streamed rather than held whole.
 */
export const boundedGitSettings: ReadonlyArray<[string, string]> = [
  ["pack.threads", "1"],
  ["core.packedGitWindowSize", "32m"],
  ["core.packedGitLimit", "256m"],
  ["core.deltaBaseCacheLimit", "64m"],
  ["core.bigFileThreshold", "64m"],
];

/** The resources a limit is set on, as a publication's failure names them. */
export type LimitedResource = "memory" | "processor_time" | "wall_time" | "disk";

/**
 * Which of the per-process limits this machine can apply. They are set by
 * the shell's `ulimit` before it becomes Git, which works for an
 * unprivileged user wherever there is a POSIX shell, unlike cgroups. The
 * address-space limit is applied only on Linux: macOS accepts the setting
 * but does not enforce it. The disk and wall-time limits are the control
 * plane's own and apply everywhere.
 */
export type ApplicableLimits = {
  memory: boolean;
  processorTime: boolean;
  fileSize: boolean;
};

let probed: ApplicableLimits | undefined;

/** Learnt once per process, by asking the shell to set each limit. */
export function findApplicableLimits(): ApplicableLimits {
  probed ??= {
    memory: process.platform === "linux" && canShellSet("ulimit -v 1048576"),
    processorTime: canShellSet("ulimit -S -t 5 && ulimit -H -t 10"),
    fileSize: canShellSet("ulimit -f 1048576"),
  };
  return probed;
}

/** The limits this machine cannot apply, for a warning at startup; empty when all apply. */
export function describeUnapplicableLimits(applicable: ApplicableLimits): string[] {
  return [
    ...(applicable.memory ? [] : ["memory (address space)"]),
    ...(applicable.processorTime ? [] : ["processor time"]),
    ...(applicable.fileSize ? [] : ["file size"]),
  ];
}

/**
 * The shell script that applies the limits and then becomes Git with the
 * arguments that follow it. The soft processor limit is a few seconds
 * below the hard one, so the kernel sends SIGXCPU, which says why Git
 * stopped, before it would send SIGKILL, which does not. The soft limit is
 * lowered first: a hard limit below the soft one is refused.
 */
export function buildLimitingScript(limits: GitChildLimits, applicable: ApplicableLimits): string {
  const settings = [
    ...(applicable.processorTime
      ? [`ulimit -S -t ${limits.processorSeconds}`, `ulimit -H -t ${limits.processorSeconds + 5}`]
      : []),
    // POSIX shells count file sizes in blocks of 512 bytes.
    ...(applicable.fileSize ? [`ulimit -f ${Math.ceil(limits.diskInBytes / 512)}`] : []),
    ...(applicable.memory ? [`ulimit -v ${Math.ceil(limits.addressSpaceInBytes / 1024)}`] : []),
  ];
  return [...settings, 'exec git "$@"'].join(" && ");
}

/** SIGXCPU and SIGXFSZ are 24 and 25 on Linux and on macOS. */
const signalNumbers = { SIGXCPU: 24, SIGXFSZ: 25 } as const;

/**
 * Which limit stopped Git, if one did, from how it ended: killed by the
 * kernel for processor time or file size (itself, or a process it ran,
 * which Git reports as "died of signal"), or failing to allocate memory.
 */
export function findExceededLimit(
  signal: NodeJS.Signals | null,
  standardError: string,
): LimitedResource | undefined {
  const childSignal = Number(/died of signal (\d+)/.exec(standardError)?.[1]);
  if (signal === "SIGXCPU" || childSignal === signalNumbers.SIGXCPU) {
    return "processor_time";
  }
  if (signal === "SIGXFSZ" || childSignal === signalNumbers.SIGXFSZ) {
    return "disk";
  }
  if (/out of memory|malloc failed|mmap failed|cannot allocate memory/i.test(standardError)) {
    return "memory";
  }
  return undefined;
}

function canShellSet(command: string): boolean {
  const outcome = spawnSync("/bin/sh", ["-c", command], { stdio: "ignore", timeout: 5_000 });
  return outcome.status === 0;
}
