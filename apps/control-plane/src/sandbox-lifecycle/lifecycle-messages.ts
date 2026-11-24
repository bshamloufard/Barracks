import { maximumErrorMessageLength } from "@barrack/protocol";
import {
  SandboxImageUnavailableError,
  SandboxProviderError,
  SandboxProviderUnavailableError,
  type SandboxStatus,
} from "@barrack/sandbox-providers";
import type { LimitReached, ThreadRecord } from "../threads/thread-store.js";

/**
 * What users are told about their sandboxes' lifecycle, in one place so the
 * wording stays consistent. Every text fits the protocol's limit on error
 * messages.
 */

/** Recorded as a run's end when the sandbox stopped before the agent reported it. */
export const runEndedByStopMessage =
  "its sandbox was stopped before it reported the end of this run, so anything it did after the last step shown here was lost. Send a message to carry on.";

/** Recorded as a run's end when the provider stopped or lost the sandbox by itself. */
export const runEndedBySandboxStoppingMessage =
  "its sandbox stopped without being asked to, so this run could not finish. Anything it did after the last step shown here was lost.";

/** Recorded with a sandbox the provider reports stopped while the control plane thought it running. */
export const stoppedFromOutsideProblem =
  "Its sandbox was stopped by something other than Barrack: its provider, or someone with access to it. Send a message, or resume the thread, to start it again.";

/**
 * Why a running sandbox's thread failed, for the user, from what its
 * provider reports, and what to do about it.
 */
export function describeSandboxFailure(
  status: Extract<SandboxStatus, { state: "failed" }>,
): string {
  switch (status.cause) {
    case "supervisor-refused-to-start":
      return limitLength(
        `Its sandbox stopped because its supervisor refused to start: ${status.reason}. Starting it again will fail the same way until this installation is fixed; tell its administrator.`,
      );
    case "out-of-memory":
      return limitLength(
        "Its sandbox ran out of memory and was stopped. Resume the thread to start it again; if the agent's work needs more memory, it will stop again.",
      );
    case "out-of-disk":
      return limitLength(
        `Its sandbox stopped because a disk was full: ${status.reason}. Resume the thread to start it again once there is room.`,
      );
    case "provider-fault":
      return limitLength(
        `Its sandbox's provider reports a fault: ${status.reason}. Resume the thread to try again.`,
      );
    case "supervisor-exited":
      return limitLength(
        `Its sandbox stopped by itself: ${status.reason}. Resume the thread to start it again.`,
      );
  }
}

/**
 * Why a sandbox that ran without its supervisor ever connecting was stopped,
 * naming the likely causes, the commonest being an address for the control
 * plane that sandboxes cannot reach.
 */
export function describeSupervisorNeverAttached(
  deadlineInMilliseconds: number,
  controlPlaneUrlForSandboxes: string,
): string {
  const minutes = Math.round(deadlineInMilliseconds / 60_000);
  return limitLength(
    `Its sandbox started, but its supervisor did not connect to the control plane within ${minutes} minutes, so the sandbox was stopped. The likely cause is that sandboxes cannot reach the control plane at ${controlPlaneUrlForSandboxes}, the address this installation gives them (BARRACK_SANDBOX_CONTROL_PLANE_URL), or that its sandbox image is not the one this control plane expects. Tell this installation's administrator, and resume the thread once it is fixed.`,
  );
}

export const sandboxLostReason =
  "Its sandbox no longer exists at the sandbox provider, so its files and the agent's memory of the conversation are gone. Delete this thread, and start a new one to carry on.";

export type LimitedAction = "create" | "resume" | "wake";

/**
 * Says which limit was reached, what that stops, and what to do about it,
 * naming the user's own sandboxes that take a place.
 */
export function describeLimitReached(limitReached: LimitReached, action: LimitedAction): string {
  const { maximum, occupying } = limitReached;
  const sandboxes = maximum === 1 ? "1 sandbox" : `${maximum} sandboxes`;
  const reached =
    limitReached.limit === "per_user"
      ? `You already have ${sandboxes} running, the most allowed at once`
      : `This installation already runs ${sandboxes}, the most it allows at once`;
  const remedy =
    occupying.length === 0
      ? "Try again once another sandbox has stopped."
      : `Stop one of yours first: ${occupying.map(describeOccupyingThread).join(", ")}.`;
  return limitLength(`${reached}, so ${describeBlockedAction(action)}. ${remedy}`);
}

function describeBlockedAction(action: LimitedAction): string {
  switch (action) {
    case "create":
      return "a new thread cannot start";
    case "resume":
      return "this thread cannot be resumed";
    case "wake":
      return "your message was not sent: this thread's sandbox is stopped, and waking it would go over the limit";
  }
}

function describeOccupyingThread(thread: ThreadRecord): string {
  const name = thread.title === undefined ? "a thread with no messages yet" : `"${thread.title}"`;
  switch (thread.sandbox.state) {
    case "stopping":
      return `${name} (already stopping; wait a moment)`;
    case "deleting":
      return `${name} (being deleted; wait a moment)`;
    case "creating":
    case "starting":
      return `${name} (starting)`;
    default:
      return `${name} (running)`;
  }
}

/**
 * Provider errors say what was attempted and what went wrong, and never
 * contain the supervisor's environment; anything else is a bug, whose
 * details belong in the log rather than on the page.
 */
export function describeProviderFailure(attempt: string, error: unknown): string {
  if (error instanceof SandboxImageUnavailableError) {
    return limitLength(
      `${attempt}: ${error.message}. This installation's sandbox image is missing; its administrator must make it available (see the deployment guide).`,
    );
  }
  if (error instanceof SandboxProviderUnavailableError) {
    return limitLength(`${attempt}: ${error.message}. The sandbox provider may be back later.`);
  }
  if (error instanceof SandboxProviderError) {
    return limitLength(`${attempt}: ${error.message}.`);
  }
  return `${attempt}: the control plane failed unexpectedly; its log has the details.`;
}

export function limitLength(text: string): string {
  return text.length <= maximumErrorMessageLength
    ? text
    : `${text.slice(0, maximumErrorMessageLength - 1)}…`;
}
