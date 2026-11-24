import { randomUUID } from "node:crypto";
import type { RecordedThreadEvent, ThreadEvent } from "@barrack/protocol";
import type { ThreadEventLog } from "../thread-event-log/thread-event-log.js";

/**
 * Puts an event into a thread's history directly, for tests that need
 * history to exist but are not about how it was recorded: a user message as
 * a client's would be, a publication's outcome as the control plane's
 * would be, and anything else as an event from a supervisor instance of
 * its own. Returns it as recorded.
 */
export async function recordTestEvent(
  threadEventLog: ThreadEventLog,
  threadId: string,
  event: ThreadEvent,
): Promise<RecordedThreadEvent> {
  if (event.type === "user_message") {
    return (await threadEventLog.appendUserMessage(threadId, event)).recordedEvent;
  }
  const outcome =
    event.type === "repository_published" || event.type === "repository_publication_failed"
      ? await threadEventLog.appendPublicationOutcome(threadId, event, randomUUID())
      : await threadEventLog.appendSupervisorEvent(threadId, event, {
          supervisorInstanceId: randomUUID(),
          eventNumber: 1,
        });
  if (outcome.isAlreadyRecorded) {
    throw new Error("An event under a key of its own was recorded already");
  }
  return outcome.recordedEvent;
}
