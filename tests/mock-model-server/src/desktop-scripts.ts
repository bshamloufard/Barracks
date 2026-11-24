import { decodePng, findColour } from "./screenshot-reading.js";

/**
 * Scripts for the agent's computer tool, played one step per request and
 * chosen by what the conversation since the triggering message holds, so
 * a test drives the real Pi through the real desktop:
 *
 * - `RUN_DESKTOP_BROWSE <url>`: look at the screen, start Firefox on the
 *   URL from bash, then wait and look until the test page shows, click its
 *   green button (which leads to a second page), then its blue one (which
 *   turns the page yellow), and say so. The buttons are found by decoding
 *   the screenshot the model was last sent, so each click lands only if the
 *   tool's coordinates are the image's.
 * - `RUN_DESKTOP_CLICK`: click the middle of the screen once, then repeat
 *   what the tool answered, so a test can see it refused while the user
 *   holds the desktop.
 */
export const desktopTriggers = {
  browse: "RUN_DESKTOP_BROWSE ",
  click: "RUN_DESKTOP_CLICK",
} as const;

/** The colours of the test pages the browse script looks for, as red, green and blue. */
export const desktopTestPageColours = {
  firstPageButton: [0x22, 0xaa, 0x66],
  secondPageButton: [0x22, 0x55, 0xdd],
  finishedPage: [0xff, 0xdd, 0x55],
} as const;

export type ScriptedReply =
  | { kind: "tool_call"; text: string; toolName: string; toolArguments: Record<string, unknown> }
  | { kind: "text"; text: string };

type Message = { role: string; content: unknown; tool_calls?: unknown };

/** Enough tries for Firefox to start on a busy machine; then the script gives up. */
const mostBrowseSteps = 30;

/** The reply for a conversation that is following a desktop script, or undefined if none is. */
export function planDesktopReply(messages: readonly Message[]): ScriptedReply | undefined {
  const triggerIndex = messages.findLastIndex(
    (message) =>
      message.role === "user" &&
      Object.values(desktopTriggers).some((trigger) => textOf(message).startsWith(trigger)),
  );
  const trigger = messages[triggerIndex];
  if (trigger === undefined) {
    return undefined;
  }
  const since = messages.slice(triggerIndex + 1);
  const triggerText = textOf(trigger);
  if (triggerText.startsWith(desktopTriggers.click)) {
    return planClick(since);
  }
  return planBrowse(triggerText.slice(desktopTriggers.browse.length).trim(), since);
}

function planClick(since: readonly Message[]): ScriptedReply {
  const toolResults = since.filter((message) => message.role === "tool");
  if (toolResults.length === 0) {
    return computer("Clicking the middle of the screen.", {
      action: "left_click",
      coordinate: [640, 400],
    });
  }
  return { kind: "text", text: `The computer tool answered: ${textOf(toolResults.at(-1))}` };
}

function planBrowse(url: string, since: readonly Message[]): ScriptedReply {
  const toolResultCount = since.filter((message) => message.role === "tool").length;
  if (toolResultCount === 0) {
    return computer("Let me look at the screen first.", { action: "screenshot" });
  }
  if (!since.some(isBashCall)) {
    return {
      kind: "tool_call",
      text: "I'll open the browser on the page.",
      toolName: "bash",
      toolArguments: { command: `firefox '${url}' >/dev/null 2>&1 &` },
    };
  }
  const screenshot = latestScreenshot(since);
  const image = screenshot === undefined ? undefined : decodePng(screenshot);
  if (image !== undefined && findColour(image, desktopTestPageColours.finishedPage)) {
    return {
      kind: "text",
      text: "Clicked through both pages; the page is yellow now, so it worked.",
    };
  }
  const nextButton =
    image === undefined
      ? undefined
      : (findColour(image, desktopTestPageColours.secondPageButton) ??
        findColour(image, desktopTestPageColours.firstPageButton));
  if (nextButton !== undefined) {
    return computer(`The button is at (${nextButton.x}, ${nextButton.y}); clicking it.`, {
      action: "left_click",
      coordinate: [nextButton.x, nextButton.y],
    });
  }
  if (toolResultCount > mostBrowseSteps) {
    return { kind: "text", text: "The page never showed its button." };
  }
  return computer("Waiting for the page.", { action: "wait", duration: 2 });
}

function computer(text: string, toolArguments: Record<string, unknown>): ScriptedReply {
  return { kind: "tool_call", text, toolName: "computer", toolArguments };
}

function isBashCall(message: Message): boolean {
  return (
    message.role === "assistant" &&
    Array.isArray(message.tool_calls) &&
    message.tool_calls.some(
      (call: unknown) =>
        typeof call === "object" &&
        call !== null &&
        "function" in call &&
        (call.function as { name?: unknown }).name === "bash",
    )
  );
}

/**
 * Pi's `openai-completions` API sends a tool's images in a user message
 * after the tool results, as data URLs.
 */
function latestScreenshot(since: readonly Message[]): Buffer | undefined {
  const prefix = "data:image/png;base64,";
  const urls = since.flatMap((message) =>
    Array.isArray(message.content)
      ? message.content.flatMap((part: unknown) => {
          const url =
            typeof part === "object" && part !== null && "image_url" in part
              ? (part.image_url as { url?: unknown }).url
              : undefined;
          return typeof url === "string" && url.startsWith(prefix) ? [url] : [];
        })
      : [],
  );
  const latest = urls.at(-1);
  return latest === undefined ? undefined : Buffer.from(latest.slice(prefix.length), "base64");
}

function textOf(message: Message | undefined): string {
  if (message === undefined) {
    return "";
  }
  if (typeof message.content === "string") {
    return message.content;
  }
  if (!Array.isArray(message.content)) {
    return "";
  }
  return message.content
    .map((part: unknown) =>
      typeof part === "object" && part !== null && "text" in part ? String(part.text) : "",
    )
    .join("");
}
