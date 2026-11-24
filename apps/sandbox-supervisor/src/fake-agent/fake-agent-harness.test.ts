import { agentEventSchema, streamFragmentSchema } from "@barrack/protocol";
import { describe, expect, it } from "vitest";
import { RecordingObserver } from "../test-support/recording-observer.js";
import { pause, waitUntil } from "../test-support/wait-until.js";
import { FakeAgentHarness, fakeAgentTriggers } from "./fake-agent-harness.js";

function createHarness(stepDelayInMilliseconds = 1) {
  const observer = new RecordingObserver();
  let identifierCount = 0;
  const harness = new FakeAgentHarness(observer, {
    stepDelayInMilliseconds,
    mintIdentifier: () => `fake-${++identifierCount}`,
  });
  return { observer, harness };
}

function hasSettled(observer: RecordingObserver, runCount = 1): () => boolean {
  return () =>
    observer.countEvents("agent_run_settled") + observer.countEvents("agent_failed") >= runCount;
}

describe("FakeAgentHarness", () => {
  it("answers a message with run started, text fragments, the completed message and run settled", async () => {
    const { observer, harness } = createHarness();

    harness.deliverUserMessage({ messageId: "user-1", text: "hello there" });
    await waitUntil(hasSettled(observer), "the run settles");

    expect(observer.outputTypes).toEqual([
      "agent_run_started",
      "fragment",
      "fragment",
      "fragment",
      "fragment",
      "assistant_message",
      "agent_run_settled",
    ]);
    expect(observer.events[1]).toEqual({
      type: "assistant_message",
      messageId: "fake-1",
      content: [{ type: "text", text: 'You said: "hello there"' }],
      endReason: "completed",
    });
    expect(observer.events[2]).toEqual({ type: "agent_run_settled", wasInterrupted: false });
  });

  it("streams fragments that add up to the completed message", async () => {
    const { observer, harness } = createHarness();

    harness.deliverUserMessage({ messageId: "user-1", text: "count the words" });
    await waitUntil(hasSettled(observer), "the run settles");

    const streamedText = observer.outputs
      .flatMap((output) => (output.kind === "fragment" ? [output.fragment.appendedText] : []))
      .join("");
    expect(streamedText).toBe('You said: "count the words"');
  });

  it("runs a tool before replying when the message asks for one", async () => {
    const { observer, harness } = createHarness();

    harness.deliverUserMessage({
      messageId: "user-1",
      text: `please ${fakeAgentTriggers.toolExecution}`,
    });
    await waitUntil(hasSettled(observer), "the run settles");

    expect(observer.eventTypes).toEqual([
      "agent_run_started",
      "assistant_message",
      "tool_execution_started",
      "tool_execution_finished",
      "assistant_message",
      "agent_run_settled",
    ]);
    expect(observer.events[1]).toMatchObject({
      endReason: "tool_use_requested",
      content: [{ type: "text" }, { type: "tool_call", toolCallId: "fake-1", toolName: "echo" }],
    });
    expect(observer.events[3]).toMatchObject({ toolCallId: "fake-1", isError: false });
  });

  it("answers messages that arrive while it is busy within the same run", async () => {
    const { observer, harness } = createHarness();

    harness.deliverUserMessage({ messageId: "user-1", text: "first" });
    harness.deliverUserMessage({ messageId: "user-2", text: "second" });
    await waitUntil(hasSettled(observer), "the run settles");

    expect(observer.eventTypes).toEqual([
      "agent_run_started",
      "assistant_message",
      "assistant_message",
      "agent_run_settled",
    ]);
  });

  it("stops streaming when interrupted and drops messages it had not started on", async () => {
    const { observer, harness } = createHarness(20);

    harness.deliverUserMessage({ messageId: "user-1", text: "a long answer please" });
    harness.deliverUserMessage({ messageId: "user-2", text: "never answered" });
    await waitUntil(() => observer.outputTypes.includes("fragment"), "the first fragment arrives");
    await harness.interrupt();

    expect(observer.eventTypes).toEqual([
      "agent_run_started",
      "assistant_message",
      "agent_run_settled",
    ]);
    expect(observer.events[1]).toMatchObject({ endReason: "interrupted" });
    expect(observer.events[2]).toEqual({ type: "agent_run_settled", wasInterrupted: true });
  });

  it("settles the run as interrupted when stopped in the middle of it", async () => {
    const { observer, harness } = createHarness(20);

    harness.deliverUserMessage({ messageId: "user-1", text: "a long answer please" });
    await waitUntil(() => observer.outputTypes.includes("fragment"), "the first fragment arrives");
    await harness.stop();

    expect(observer.eventTypes).toEqual([
      "agent_run_started",
      "assistant_message",
      "agent_run_settled",
    ]);
    expect(observer.events.at(-1)).toEqual({ type: "agent_run_settled", wasInterrupted: true });
    expect(observer.processEndings).toEqual([
      { wasExpected: true, description: expect.any(String) },
    ]);
  });

  it("ignores user messages once stopped", async () => {
    const { observer, harness } = createHarness();

    await harness.stop();
    harness.deliverUserMessage({ messageId: "user-1", text: "anyone there?" });
    await pause(20);

    expect(observer.outputs).toEqual([]);
  });

  it("does nothing when interrupted while idle", async () => {
    const { observer, harness } = createHarness();

    await harness.interrupt();

    expect(observer.outputs).toEqual([]);
  });

  it("fails like a crashed agent when the message asks it to, and runs again on the next message", async () => {
    const { observer, harness } = createHarness();

    harness.deliverUserMessage({
      messageId: "user-1",
      text: `please ${fakeAgentTriggers.failure}`,
    });
    await waitUntil(hasSettled(observer), "the agent fails");
    harness.deliverUserMessage({ messageId: "user-2", text: "are you back?" });
    await waitUntil(hasSettled(observer, 2), "the second run settles");

    expect(observer.eventTypes).toEqual([
      "agent_run_started",
      "agent_failed",
      "agent_run_started",
      "assistant_message",
      "agent_run_settled",
    ]);
    expect(observer.processEndings).toEqual([
      { wasExpected: false, description: expect.any(String) },
    ]);
  });

  it("emits only events and fragments that satisfy the protocol", async () => {
    const { observer, harness } = createHarness();

    harness.deliverUserMessage({ messageId: "user-1", text: `${fakeAgentTriggers.toolExecution}` });
    await waitUntil(hasSettled(observer), "the run settles");

    for (const output of observer.outputs) {
      const schema = output.kind === "event" ? agentEventSchema : streamFragmentSchema;
      expect(
        schema.safeParse(output.kind === "event" ? output.event : output.fragment).success,
      ).toBe(true);
    }
  });
});
