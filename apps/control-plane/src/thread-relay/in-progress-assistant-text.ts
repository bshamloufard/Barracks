import { type AssistantTextFragment, maximumFrameLength } from "@barrack/protocol";

type ContentBlockText = Pick<AssistantTextFragment, "contentBlockType"> & { text: string };

/**
 * A message whose completed event will have to fit in one frame never gets
 * near this. The bound exists so a misbehaving supervisor cannot grow memory
 * without limit, and is half a frame so the coalesced fragment, once its
 * text is escaped as JSON, still fits in a frame a client will accept.
 */
const maximumTextLengthPerMessage = maximumFrameLength / 2;

/**
 * The text streamed so far for each assistant message that is still being
 * produced. Stream fragments are never stored, so without this a client that
 * connects in the middle of a message would see it start mid-sentence. It is
 * kept only until the completed message is recorded, which supersedes it.
 */
export class InProgressAssistantText {
  readonly #blocksByMessageId = new Map<string, Map<number, ContentBlockText>>();

  /** Returns false, and stops tracking the message, if it grew past the size limit. */
  append(fragment: AssistantTextFragment): boolean {
    const blocks = this.#blocksByMessageId.get(fragment.messageId) ?? new Map();
    this.#blocksByMessageId.set(fragment.messageId, blocks);
    const block = blocks.get(fragment.contentBlockIndex) ?? {
      contentBlockType: fragment.contentBlockType,
      text: "",
    };
    block.text += fragment.appendedText;
    blocks.set(fragment.contentBlockIndex, block);
    if (totalTextLength(blocks) > maximumTextLengthPerMessage) {
      this.discardMessage(fragment.messageId);
      return false;
    }
    return true;
  }

  discardMessage(messageId: string): void {
    this.#blocksByMessageId.delete(messageId);
  }

  discardAll(): void {
    this.#blocksByMessageId.clear();
  }

  /** One fragment per content block, carrying all of that block's text so far. */
  toCoalescedFragments(): AssistantTextFragment[] {
    const fragments: AssistantTextFragment[] = [];
    for (const [messageId, blocks] of this.#blocksByMessageId) {
      const blocksInOrder = [...blocks].sort(
        ([firstIndex], [secondIndex]) => firstIndex - secondIndex,
      );
      for (const [contentBlockIndex, block] of blocksInOrder) {
        fragments.push({
          type: "assistant_text_fragment",
          messageId,
          contentBlockIndex,
          contentBlockType: block.contentBlockType,
          appendedText: block.text,
        });
      }
    }
    return fragments;
  }
}

function totalTextLength(blocks: Map<number, ContentBlockText>): number {
  let length = 0;
  for (const block of blocks.values()) {
    length += block.text.length;
  }
  return length;
}
