import {
  type AssistantTextFragment,
  maximumFrameLength,
  parseControlPlaneToClientMessage,
} from "@barrack/protocol";
import { describe, expect, it } from "vitest";
import { InProgressAssistantText } from "./in-progress-assistant-text.js";

function fragment(
  messageId: string,
  appendedText: string,
  contentBlockIndex = 0,
): AssistantTextFragment {
  return {
    type: "assistant_text_fragment",
    messageId,
    contentBlockIndex,
    contentBlockType: "text",
    appendedText,
  };
}

/** Longer than the text kept for one message, which is half a frame. */
const textPastTheLimit = "x".repeat(maximumFrameLength / 2 + 1);

describe("in-progress assistant text", () => {
  it("coalesces each content block's fragments into one, in block order", () => {
    const inProgressText = new InProgressAssistantText();

    inProgressText.append(fragment("assistant-1", "World", 1));
    inProgressText.append(fragment("assistant-1", "Hel", 0));
    inProgressText.append(fragment("assistant-1", "lo", 0));

    expect(inProgressText.toCoalescedFragments()).toEqual([
      fragment("assistant-1", "Hello", 0),
      fragment("assistant-1", "World", 1),
    ]);
  });

  it("keeps only the newest message, so a supervisor cannot make it track many", () => {
    const inProgressText = new InProgressAssistantText();

    inProgressText.append(fragment("assistant-1", "Abandoned"));
    inProgressText.append(fragment("assistant-2", "Current"));

    expect(inProgressText.toCoalescedFragments()).toEqual([fragment("assistant-2", "Current")]);
  });

  it("reports a message whose text grows past the limit and keeps none of it", () => {
    const inProgressText = new InProgressAssistantText();

    inProgressText.append(fragment("assistant-1", "Hello"));
    const outcome = inProgressText.append(fragment("assistant-1", textPastTheLimit));

    expect(outcome).toBe("exceeded_limit");
    expect(inProgressText.toCoalescedFragments()).toEqual([]);
  });

  it("measures the limit in escaped text, so every coalesced fragment fits in a frame", () => {
    const inProgressText = new InProgressAssistantText();
    // A control character is six characters long once escaped as JSON.
    const fragmentText = "\u0001".repeat(64 * 1024);
    const fittingFragmentCount = Math.floor(maximumFrameLength / 2 / (6 * fragmentText.length));

    for (let count = 0; count < fittingFragmentCount; count += 1) {
      inProgressText.append(fragment("assistant-1", fragmentText));
    }
    const [coalescedFragment] = inProgressText.toCoalescedFragments();
    const outcome = inProgressText.append(fragment("assistant-1", fragmentText));

    const coalescedFrame = JSON.stringify({ type: "stream_fragment", fragment: coalescedFragment });
    expect(coalescedFrame.length).toBeLessThanOrEqual(maximumFrameLength);
    expect(parseControlPlaneToClientMessage(coalescedFrame).ok).toBe(true);
    expect(outcome).toBe("exceeded_limit");
  });

  it("keeps no more of a message that went past the limit, so a joining client never starts mid-message", () => {
    const inProgressText = new InProgressAssistantText();
    inProgressText.append(fragment("assistant-1", textPastTheLimit));

    const outcome = inProgressText.append(fragment("assistant-1", "more text"));

    expect(outcome).toBe("already_over_limit");
    expect(inProgressText.toCoalescedFragments()).toEqual([]);
  });

  it("keeps the text of the next message after one that went past the limit", () => {
    const inProgressText = new InProgressAssistantText();
    inProgressText.append(fragment("assistant-1", textPastTheLimit));

    const outcome = inProgressText.append(fragment("assistant-2", "Fresh start"));

    expect(outcome).toBe("kept");
    expect(inProgressText.toCoalescedFragments()).toEqual([fragment("assistant-2", "Fresh start")]);
  });

  it("treats a message with too many content blocks as past the limit, however short their text", () => {
    const inProgressText = new InProgressAssistantText();

    // Far more blocks than any real message has; stops early once the limit is hit.
    let outcome = inProgressText.append(fragment("assistant-1", "", 0));
    for (let contentBlockIndex = 1; outcome === "kept" && contentBlockIndex < 100_000; ) {
      outcome = inProgressText.append(fragment("assistant-1", "", contentBlockIndex));
      contentBlockIndex += 1;
    }

    expect(outcome).toBe("exceeded_limit");
    expect(inProgressText.toCoalescedFragments()).toEqual([]);
  });

  it("forgets a message once its completed version is recorded", () => {
    const inProgressText = new InProgressAssistantText();
    inProgressText.append(fragment("assistant-1", "Hello"));

    inProgressText.discardMessage("assistant-1");

    expect(inProgressText.toCoalescedFragments()).toEqual([]);
  });

  it("keeps the current message when a different one is recorded", () => {
    const inProgressText = new InProgressAssistantText();
    inProgressText.append(fragment("assistant-2", "Hello"));

    inProgressText.discardMessage("assistant-1");

    expect(inProgressText.toCoalescedFragments()).toEqual([fragment("assistant-2", "Hello")]);
  });
});
