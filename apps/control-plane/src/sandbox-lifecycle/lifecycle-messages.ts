import { maximumErrorMessageLength } from "@barrack/protocol";
import { SandboxProviderError, SandboxProviderUnavailableError } from "@barrack/sandbox-providers";
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
