import { type AssistantTextFragment, maximumFrameLength } from "@barrack/protocol";

type ContentBlockText = Pick<AssistantTextFragment, "contentBlockType"> & {
  text: string;
  /** How long the text is once escaped as a JSON string, which is what a frame carries. */
  serializedLength: number;
};

type CurrentMessage = {
  messageId: string;
  /** Undefined once the message has gone past a limit: none of its text is kept from then on. */
  blocksByIndex: Map<number, ContentBlockText> | undefined;
};

/**
 * What became of a fragment: its text was kept, its message has just gone
 * past a limit, or its message had already gone past one.
 */
export type AppendOutcome = "kept" | "exceeded_limit" | "already_over_limit";

/**
 * A message whose completed event will have to fit in one frame never gets
 * near this. The bound exists so a misbehaving supervisor cannot grow memory
 * without limit, and is measured in escaped JSON, as it is sent, so that
 * each coalesced fragment fits in a frame a client will accept, whatever
 * characters its text holds, with room to spare for the rest of the frame.
 */
const maximumSerializedTextLengthPerMessage = maximumFrameLength / 2;

/**
 * Real messages have a handful of content blocks (some thinking, some text,
 * a few tool calls). Without this bound a supervisor could grow memory with
 * empty fragments for ever-new block indices, which the text bound never sees.
 */
const maximumContentBlocksPerMessage = 1_000;

/**
 * The text streamed so far for the assistant message still being produced.
 * Stream fragments are never stored, so without this a client that connects
 * in the middle of a message would see it start mid-sentence.
 *
 * Only the current message is kept, because the supervisor is untrusted and
 * must not be able to make the control plane hold text for many messages; an
 * agent produces its messages one after another anyway. The completed
 * message, once recorded, supersedes its streamed text, and text that was
 * never completed is discarded when another message starts streaming and
 * when the run settles or fails (the relay calls `discardCurrentMessage`).
 * The web client's reducer applies the same rule to what a page that is
 * watching shows (`applyAssistantTextFragment` in
 * apps/web/src/thread-state/thread-state.ts), so a page that reconnects shows
 * the same as a page that watched all along.
 *
 * A message that goes past a limit is remembered as such, and none of its
 * text is kept until a different message starts: picking it up again from
 * the next fragment would send a joining client text that starts mid-message.
 */
export class InProgressAssistantText {
  #currentMessage: CurrentMessage | undefined;

  append(fragment: AssistantTextFragment): AppendOutcome {
    const message = this.#startOrContinue(fragment.messageId);
    const blocksByIndex = message.blocksByIndex;
    if (blocksByIndex === undefined) {
      return "already_over_limit";
    }
    appendToBlock(blocksByIndex, fragment);
    if (isPastLimits(blocksByIndex)) {
      message.blocksByIndex = undefined;
      return "exceeded_limit";
    }
    return "kept";
  }

  /** Called once the completed message is recorded, which supersedes its streamed text. */
  discardMessage(messageId: string): void {
    if (this.#currentMessage?.messageId === messageId) {
      this.#currentMessage = undefined;
    }
  }

  discardCurrentMessage(): void {
    this.#currentMessage = undefined;
  }

  /** One fragment per content block, carrying all of that block's text so far. */
  toCoalescedFragments(): AssistantTextFragment[] {
    const message = this.#currentMessage;
    if (message?.blocksByIndex === undefined) {
      return [];
    }
    const blocksInOrder = [...message.blocksByIndex].sort(
      ([firstIndex], [secondIndex]) => firstIndex - secondIndex,
    );
    return blocksInOrder.map(([contentBlockIndex, block]) => ({
      type: "assistant_text_fragment",
      messageId: message.messageId,
      contentBlockIndex,
      contentBlockType: block.contentBlockType,
      appendedText: block.text,
    }));
  }

  #startOrContinue(messageId: string): CurrentMessage {
    if (this.#currentMessage?.messageId !== messageId) {
      this.#currentMessage = { messageId, blocksByIndex: new Map() };
    }
    return this.#currentMessage;
  }
}

function appendToBlock(
  blocksByIndex: Map<number, ContentBlockText>,
  fragment: AssistantTextFragment,
): void {
  const block = blocksByIndex.get(fragment.contentBlockIndex) ?? {
    contentBlockType: fragment.contentBlockType,
    text: "",
    serializedLength: 0,
  };
  block.text += fragment.appendedText;
  // Escaping the pieces separately can only overcount (a surrogate pair split
  // between two fragments is escaped as two), which errs on the safe side.
  block.serializedLength += measureEscapedText(fragment.appendedText);
  blocksByIndex.set(fragment.contentBlockIndex, block);
}

function isPastLimits(blocksByIndex: Map<number, ContentBlockText>): boolean {
  return (
    blocksByIndex.size > maximumContentBlocksPerMessage ||
    totalSerializedLength(blocksByIndex) > maximumSerializedTextLengthPerMessage
  );
}

function totalSerializedLength(blocksByIndex: Map<number, ContentBlockText>): number {
  let length = 0;
  for (const block of blocksByIndex.values()) {
    length += block.serializedLength;
  }
  return length;
}

/** The length of `text` inside a JSON string, without the quotes. */
function measureEscapedText(text: string): number {
  return JSON.stringify(text).length - 2;
}
