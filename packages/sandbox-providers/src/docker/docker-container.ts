import { z } from "zod";
import { type SandboxStatus, supervisorRefusedToStartExitCode } from "../sandbox-provider.js";

/**
 * What Barrack reads from `docker container inspect`, and how a container's
 * state maps onto a sandbox's. The inspect output is validated like any other
 * response from outside the process.
 */

/** Labels that mark a container as one of Barrack's sandboxes, and for which thread. */
export const sandboxLabel = "barrack.sandbox";
export const threadIdLabel = "barrack.thread-id";

/** Docker's full container identifiers are 64 lowercase hexadecimal characters. */
const containerIdPattern = /^[0-9a-f]{64}$/;

const inspectedContainerSchema = z.object({
  Id: z.string(),
  State: z.object({
    Status: z.string(),
    ExitCode: z.number(),
    OOMKilled: z.boolean(),
    Error: z.string(),
  }),
  Config: z.object({
    Labels: z.record(z.string(), z.string()).nullable(),
  }),
});

export type InspectedContainer = z.infer<typeof inspectedContainerSchema>;

export function isContainerId(text: string): boolean {
  return containerIdPattern.test(text);
}

/** Parses the output of `docker container inspect --format '{{json .}}'`. */
export function parseInspectedContainer(inspectOutput: string): InspectedContainer {
  return inspectedContainerSchema.parse(JSON.parse(inspectOutput));
}

export function isBarrackSandbox(container: InspectedContainer): boolean {
  return container.Config.Labels?.[sandboxLabel] === "true";
}

/** The exit codes of a supervisor that was asked to stop: cleanly, or killed after the grace period. */
const requestedStopExitCodes = new Set([0, 137, 143]);

/**
 * Whether the container's supervisor exited by itself with an error, so
 * that what it last wrote to standard error says why.
 */
export function hasSupervisorFailed(container: InspectedContainer): boolean {
  const { State: state } = container;
  return (
    state.Status === "exited" && !state.OOMKilled && !requestedStopExitCodes.has(state.ExitCode)
  );
}

/**
 * The sandbox's state, from the container's. `supervisorLastWords` is what
 * the supervisor last wrote to standard error, for a supervisor that
 * failed (`hasSupervisorFailed`), when it could be read.
 */
export function toSandboxStatus(
  container: InspectedContainer,
  supervisorLastWords?: string,
): SandboxStatus {
  const { State: state } = container;
  switch (state.Status) {
    case "running":
      return { state: "running" };
    case "restarting":
      return { state: "starting" };
    case "removing":
      return { state: "stopping" };
    // A container that was created but never started has no processes and
    // its files are intact, which is what a stopped sandbox is.
    case "created":
      return { state: "stopped" };
    case "exited":
      return describeExitedContainer(state, supervisorLastWords);
    default:
      return {
        state: "failed",
        cause: "provider-fault",
        reason: `the container is ${state.Status}${state.Error === "" ? "" : `: ${state.Error}`}`,
      };
  }
}

/** Docker's own words, and the C library's, for a full disk. */
const fullDiskPattern = /ENOSPC|no space left on device/i;

function describeExitedContainer(
  state: InspectedContainer["State"],
  supervisorLastWords: string | undefined,
): SandboxStatus {
  if (state.OOMKilled) {
    return { state: "failed", cause: "out-of-memory", reason: "the sandbox ran out of memory" };
  }
  if (requestedStopExitCodes.has(state.ExitCode)) {
    return { state: "stopped" };
  }
  const saying = supervisorLastWords === undefined ? "" : `, saying: ${supervisorLastWords}`;
  if (state.ExitCode === supervisorRefusedToStartExitCode) {
    return {
      state: "failed",
      cause: "supervisor-refused-to-start",
      reason: `the supervisor refused to start${saying}`,
    };
  }
  return {
    state: "failed",
    cause: fullDiskPattern.test(supervisorLastWords ?? "") ? "out-of-disk" : "supervisor-exited",
    reason: `the supervisor exited with code ${state.ExitCode}${saying}`,
  };
}

/** Lines of standard error kept as the supervisor's last words, and how long they may run. */
const lastWordsLineCount = 6;
const longestLastWordsLength = 600;

/**
 * The supervisor's last words, from the end of what the container wrote to
 * standard error (where the supervisor writes why it stopped; its log lines
 * go to standard output): its last few lines, joined, and cut short.
 */
export function summariseLastWords(standardError: string): string | undefined {
  const lines = standardError
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-lastWordsLineCount);
  if (lines.length === 0) {
    return undefined;
  }
  const lastWords = lines.join(" ");
  return lastWords.length > longestLastWordsLength
    ? `${lastWords.slice(0, longestLastWordsLength - 1)}…`
    : lastWords;
}
