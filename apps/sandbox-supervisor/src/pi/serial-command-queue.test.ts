import { describe, expect, it } from "vitest";
import { pause } from "../test-support/wait-until.js";
import { SerialCommandQueue } from "./serial-command-queue.js";

describe("SerialCommandQueue", () => {
  it("starts each operation only after the one before it has finished", async () => {
    const queue = new SerialCommandQueue();
    const steps: string[] = [];
    const slowOperation = async () => {
      steps.push("slow started");
      await pause(20);
      steps.push("slow finished");
    };
    const quickOperation = async () => {
      steps.push("quick started");
    };

    await Promise.all([queue.run(slowOperation), queue.run(quickOperation)]);

    expect(steps).toEqual(["slow started", "slow finished", "quick started"]);
  });

  it("gives each caller its own operation's result", async () => {
    const queue = new SerialCommandQueue();

    const results = await Promise.all([queue.run(async () => 1), queue.run(async () => 2)]);

    expect(results).toEqual([1, 2]);
  });

  it("passes a failure to its caller and still runs the operations after it", async () => {
    const queue = new SerialCommandQueue();

    const failing = queue.run(async () => {
      throw new Error("Pi went away.");
    });
    const following = queue.run(async () => "still ran");

    await expect(failing).rejects.toThrow("Pi went away.");
    await expect(following).resolves.toBe("still ran");
  });
});
