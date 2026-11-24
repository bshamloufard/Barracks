import type { RecordedThreadEvent } from "@barrack/protocol";
import type { ThreadEventLog } from "../thread-event-log/thread-event-log.js";

/** Every event of a thread in one read, which only a test's small threads can afford. */
export function readWholeThread(
  threadEventLog: ThreadEventLog,
  threadId: string,
): Promise<RecordedThreadEvent[]> {
  return threadEventLog.readEvents(threadId, {
    afterSequence: 0,
    throughSequence: Number.MAX_SAFE_INTEGER,
    limit: Number.MAX_SAFE_INTEGER,
  });
}
