import { z } from "zod";
import type { SandboxStatus } from "../sandbox-provider.js";

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

export function toSandboxStatus(container: InspectedContainer): SandboxStatus {
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
      return describeExitedContainer(state);
    default:
      return {
        state: "failed",
        reason: `the container is ${state.Status}${state.Error === "" ? "" : `: ${state.Error}`}`,
      };
  }
}

function describeExitedContainer(state: InspectedContainer["State"]): SandboxStatus {
  if (state.OOMKilled) {
    return { state: "failed", reason: "the sandbox ran out of memory" };
  }
  if (requestedStopExitCodes.has(state.ExitCode)) {
    return { state: "stopped" };
  }
  return { state: "failed", reason: `the supervisor exited with code ${state.ExitCode}` };
}
