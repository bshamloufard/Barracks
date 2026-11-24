import { describe, expect, it } from "vitest";
import { SerialTaskQueue } from "./serial-task-queue.js";

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

describe("a serial task queue", () => {
  it("finishes each task before starting the next, in the order they were added", async () => {
    const queue = new SerialTaskQueue();
    const steps: string[] = [];

    await Promise.all([
      queue.enqueue(async () => {
        steps.push("first started");
        await pause(10);
        steps.push("first finished");
      }),
      queue.enqueue(async () => {
        steps.push("second started");
        steps.push("second finished");
      }),
    ]);

    expect(steps).toEqual(["first started", "first finished", "second started", "second finished"]);
  });

  it("runs later tasks after one fails, and reports the failure to whoever added it", async () => {
    const queue = new SerialTaskQueue();
    let didLaterTaskRun = false;

    const failing = queue.enqueue(async () => {
      throw new Error("append failed");
    });
    const later = queue.enqueue(async () => {
      didLaterTaskRun = true;
    });

    await expect(failing).rejects.toThrow("append failed");
    await later;
    expect(didLaterTaskRun).toBe(true);
  });
});
