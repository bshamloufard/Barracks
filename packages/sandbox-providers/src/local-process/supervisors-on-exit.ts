import type { ChildProcess } from "node:child_process";

/**
 * A local sandbox's supervisor is a child of the control plane, and the
 * provider's record of it lives in the control plane's memory. A supervisor
 * outliving the control plane would be forgotten yet keep reconnecting, so
 * each one is asked to stop when the control plane's process exits.
 *
 * Only synchronous work can happen on exit, so this sends the signal and
 * does not wait; the supervisor stops its agent by itself. A control plane
 * killed outright (SIGKILL) runs no exit handlers; its supervisors then
 * stop only when something kills them too, as `pnpm dev` does by killing
 * the control plane's whole process group.
 */

const liveSupervisors = new Set<ChildProcess>();
let isExitHandlerInstalled = false;

export function stopSupervisorsWhenThisProcessExits(supervisor: ChildProcess): void {
  liveSupervisors.add(supervisor);
  supervisor.once("exit", () => liveSupervisors.delete(supervisor));
  // Inherited output streams would otherwise keep the control plane's event
  // loop alive after it has shut down, and its exit is what stops them.
  supervisor.unref();
  if (!isExitHandlerInstalled) {
    isExitHandlerInstalled = true;
    process.once("exit", () => {
      for (const liveSupervisor of liveSupervisors) {
        liveSupervisor.kill("SIGTERM");
      }
    });
  }
}
