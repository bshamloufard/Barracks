import type { ThreadSandbox, ThreadSummary } from "@barrack/protocol";

/**
 * How a thread and its sandbox are put for the user, in the list and on the
 * thread's page. Pure functions, tested directly.
 */

/** A thread is named by its first message; until there is one, this. */
export const untitledThreadName = "New thread";

export function threadNameOf(thread: Pick<ThreadSummary, "title">): string {
  return thread.title ?? untitledThreadName;
}

/** A word or two for the list. */
export function describeSandboxState(sandbox: ThreadSandbox): string {
  switch (sandbox.state) {
    case "creating":
      return "Starting…";
    case "running":
      return "Running";
    case "stopping":
      return "Stopping…";
    case "stopped":
      return "Stopped";
    case "starting":
      return "Waking…";
    case "failed":
      return sandbox.canResume ? "Failed" : "Sandbox gone";
    case "deleting":
      return "Deleting…";
  }
}

/** Whether the sandbox is on its way from one state to another, so its record changes soon. */
export function isSandboxChanging(sandbox: ThreadSandbox): boolean {
  return (
    sandbox.state === "creating" ||
    sandbox.state === "starting" ||
    sandbox.state === "stopping" ||
    sandbox.state === "deleting"
  );
}

export type LifecycleActions = { canStop: boolean; canResume: boolean; canDelete: boolean };

/** What the user can ask of the thread's sandbox right now; the control plane checks again. */
export function availableLifecycleActions(sandbox: ThreadSandbox): LifecycleActions {
  return {
    canStop: sandbox.state === "running",
    canResume: sandbox.state === "stopped" || (sandbox.state === "failed" && sandbox.canResume),
    canDelete:
      sandbox.state === "running" || sandbox.state === "stopped" || sandbox.state === "failed",
  };
}

export type SandboxBanner = { tone: "quiet" | "warning"; text: string };

/** A line above the conversation saying what the sandbox is doing, or nothing while it simply runs. */
export function describeSandboxBanner(sandbox: ThreadSandbox): SandboxBanner | undefined {
  switch (sandbox.state) {
    case "creating":
      return { tone: "quiet", text: "Starting its sandbox…" };
    case "running":
      return sandbox.problem === undefined ? undefined : { tone: "warning", text: sandbox.problem };
    case "stopping":
      return {
        tone: "quiet",
        text: "Stopping the sandbox… Its files are kept. A message sent now wakes it again.",
      };
    case "stopped":
      return {
        tone: sandbox.problem === undefined ? "quiet" : "warning",
        text: [
          sandbox.problem,
          "The sandbox is stopped, with its files kept. Send a message to wake it, or resume it.",
        ]
          .filter((part) => part !== undefined)
          .join(" "),
      };
    case "starting":
      return {
        tone: "quiet",
        text: "Waking the sandbox… Messages wait until the agent is back.",
      };
    case "failed":
      return { tone: "warning", text: sandbox.reason };
    case "deleting":
      return { tone: "quiet", text: "Deleting this thread…" };
  }
}

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;

/** How long ago something happened, roughly, as a list shows it. */
export function describeTimeSince(time: string, now: Date): string {
  const elapsed = Math.max(0, now.getTime() - new Date(time).getTime());
  if (elapsed < minute) {
    return "just now";
  }
  if (elapsed < hour) {
    return `${Math.floor(elapsed / minute)} min ago`;
  }
  if (elapsed < day) {
    return `${Math.floor(elapsed / hour)} h ago`;
  }
  const days = Math.floor(elapsed / day);
  return days === 1 ? "yesterday" : `${days} days ago`;
}
