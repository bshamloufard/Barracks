import type { Logger } from "../logger.js";
import type { ThreadStore } from "./thread-store.js";

/** What the user is shown for a thread whose sandbox creation a restart cut off. */
export const interruptedCreationReason =
  "The control plane restarted while this thread's sandbox was being created, so it was never finished. Create a new thread to try again.";

/**
 * Sandboxes are created in the background after a thread is recorded, so a
 * control plane that stops part way leaves threads marked as creating, which
 * nothing would ever change. At startup no creation can be under way, so
 * each of them is marked failed, with a reason the user is shown.
 *
 * The provider may have created such a sandbox after all, but its identifier
 * was never recorded, so it cannot be destroyed from here; the log says
 * which threads to look for. Finding and finishing them properly is left
 * to the fuller recovery after a restart that is still to come. This
 * assumes one control plane per database: a second one starting would fail
 * the creations the first still has under way.
 */
export async function failInterruptedSandboxCreations(
  threadStore: ThreadStore,
  logger: Logger,
): Promise<void> {
  const threadIds = await threadStore.failSandboxesStillBeingCreated(interruptedCreationReason);
  for (const threadId of threadIds) {
    logger.warn(
      { threadId },
      "Marked a thread failed whose sandbox was still being created when the control plane last stopped; any sandbox the provider made for it is unrecorded and must be removed by hand",
    );
  }
}
