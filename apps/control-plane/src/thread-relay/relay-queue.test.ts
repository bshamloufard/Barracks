import { pino } from "pino";
import { describe, expect, it } from "vitest";
import { allPendingWorkSettled } from "../test-support/fake-connections.js";
import { RelayQueue } from "./relay-queue.js";
import {
  streamFragmentsBacklogLimit,
  supervisorMessagesBacklogLimit,
} from "./supervisor-backlog.js";

function createQueue(): { queue: RelayQueue; settledTaskCount: () => number } {
  let settledTaskCount = 0;
  const queue = new RelayQueue({
    logger: pino({ level: "silent" }),
    whenTaskSettled: () => {
      settledTaskCount += 1;
    },
  });
  return { queue, settledTaskCount: () => settledTaskCount };
}

describe("a relay's queue", () => {
  it("runs tasks one at a time in the order they were queued, and is idle once they have run", async () => {
    const { queue, settledTaskCount } = createQueue();
    const order: string[] = [];
    const { promise: firstMayFinish, resolve: letFirstFinish } = Promise.withResolvers<void>();
    queue.enqueue("run the first task", async () => {
      await firstMayFinish;
      order.push("first");
    });
    queue.enqueue("run the second task", async () => {
      order.push("second");
    });
    await allPendingWorkSettled();
    expect(order).toEqual([]);
    expect(queue.isIdle).toBe(false);
    letFirstFinish();
    await allPendingWorkSettled();
    expect(order).toEqual(["first", "second"]);
    expect(queue.isIdle).toBe(true);
    expect(settledTaskCount()).toBe(2);
  });

  it("goes on with later tasks after one fails", async () => {
    const { queue } = createQueue();
    let hasLaterTaskRun = false;
    queue.enqueue("fail", async () => {
      throw new Error("The task failed.");
    });
    queue.enqueue("run after the failure", async () => {
      hasLaterTaskRun = true;
    });
    await allPendingWorkSettled();
    expect(hasLaterTaskRun).toBe(true);
    expect(queue.isIdle).toBe(true);
  });

  it("hands a task's failure to the caller that waits for it", async () => {
    const { queue } = createQueue();
    await expect(
      queue.enqueueAndWait(async () => {
        throw new Error("The task failed.");
      }),
    ).rejects.toThrow("The task failed.");
    await expect(queue.enqueueAndWait(async () => undefined)).resolves.toBeUndefined();
  });

  it("refuses a supervisor message that would take what waits past the limit, and makes room once one has run", async () => {
    const { queue } = createQueue();
    const { promise: mayFinish, resolve: letFinish } = Promise.withResolvers<void>();
    expect(
      queue.enqueueSupervisorMessage(
        supervisorMessagesBacklogLimit,
        "hold the queue",
        () => mayFinish,
      ),
    ).toBe(true);
    expect(queue.enqueueSupervisorMessage(1, "overflow", async () => undefined)).toBe(false);
    letFinish();
    await allPendingWorkSettled();
    expect(queue.queuedSupervisorLengths).toEqual({ messages: 0, fragments: 0 });
    expect(queue.enqueueSupervisorMessage(1, "fit again", async () => undefined)).toBe(true);
  });

  it("drops stream fragments past their own budget without counting them against messages", async () => {
    const { queue } = createQueue();
    const { promise: mayFinish, resolve: letFinish } = Promise.withResolvers<void>();
    queue.enqueue("hold the queue", () => mayFinish);
    expect(
      queue.enqueueStreamFragment(
        "message-1",
        streamFragmentsBacklogLimit,
        "relay",
        async () => {},
      ),
    ).toBe(true);
    expect(queue.enqueueStreamFragment("message-2", 1, "relay", async () => {})).toBe(false);
    expect(queue.queuedSupervisorLengths.messages).toBe(0);
    letFinish();
    await allPendingWorkSettled();
    expect(queue.queuedSupervisorLengths.fragments).toBe(0);
  });
});
