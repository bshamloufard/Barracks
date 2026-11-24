/**
 * Every screenshot stays in Pi's session and would be sent to the model
 * again with every later request, so only the newest few are sent as
 * images; older ones become a line of text. They are pruned in batches
 * rather than one at a time, so the start of the request (which providers
 * cache) changes once every few screenshots rather than on every turn.
 */

export const screenshotsKept = 3;
export const screenshotPruningBatch = 3;

export const omittedScreenshotText = "[earlier screenshot omitted]";

type ContentBlock = { type: string };
type ContextMessage = { role: string; toolName?: string; content?: unknown };

/**
 * The messages with all but the newest screenshots replaced, or undefined
 * when nothing needs pruning yet. Only the computer tool's results are
 * touched; the messages given are not changed.
 */
export function pruneOldScreenshots<Message extends ContextMessage>(
  messages: readonly Message[],
  toolName: string,
): Message[] | undefined {
  const positions = findScreenshots(messages, toolName);
  if (positions.length <= screenshotsKept + screenshotPruningBatch) {
    return undefined;
  }
  const prunedCount =
    Math.floor((positions.length - screenshotsKept) / screenshotPruningBatch) *
    screenshotPruningBatch;
  const pruned = new Set(positions.slice(0, prunedCount).map(describePosition));
  const prunedMessageIndexes = new Set(
    positions.slice(0, prunedCount).map(({ messageIndex }) => messageIndex),
  );
  return messages.map((message, messageIndex) => {
    if (!prunedMessageIndexes.has(messageIndex) || !Array.isArray(message.content)) {
      return message;
    }
    const content = (message.content as ContentBlock[]).map((block, blockIndex) =>
      pruned.has(describePosition({ messageIndex, blockIndex }))
        ? { type: "text", text: omittedScreenshotText }
        : block,
    );
    return { ...message, content };
  });
}

type Position = { messageIndex: number; blockIndex: number };

function findScreenshots(messages: readonly ContextMessage[], toolName: string): Position[] {
  return messages.flatMap((message, messageIndex) => {
    if (message.role !== "toolResult" || message.toolName !== toolName) {
      return [];
    }
    if (!Array.isArray(message.content)) {
      return [];
    }
    return (message.content as ContentBlock[]).flatMap((block, blockIndex) =>
      block.type === "image" ? [{ messageIndex, blockIndex }] : [],
    );
  });
}

function describePosition({ messageIndex, blockIndex }: Position): string {
  return `${messageIndex}:${blockIndex}`;
}
