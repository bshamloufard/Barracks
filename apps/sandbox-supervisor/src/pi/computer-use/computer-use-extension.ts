import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { computerActions, longestTypedText, longestWaitInSeconds } from "./computer-actions.js";
import { type ComputerToolResult, createSandboxComputerTool } from "./computer-tool.js";
import { readComputerToolSettings } from "./computer-tool-settings.js";
import { pruneOldScreenshots } from "./screenshot-pruning.js";

/**
 * The computer tool as a Pi extension, which the Pi harness loads
 * (`--extension`) in a sandbox that has a desktop. Pi compiles it itself
 * and gives it Pi's own copies of `typebox` and Pi's packages
 * (https://github.com/earendil-works/pi/blob/main/docs/extensions.md);
 * everything else here is plain Node and the files beside it. The
 * settings come from the environment the harness gives Pi
 * (`pi-environment.ts`).
 */

const toolName = "computer";

/**
 * A plain JSON-schema `enum` rather than a union of literals, which some
 * providers refuse in tool parameters.
 */
function stringEnum<Value extends string>(values: readonly Value[], description: string) {
  return Type.Unsafe<Value>({ type: "string", enum: [...values], description });
}

const coordinateSchema = (description: string) =>
  Type.Array(Type.Number(), { minItems: 2, maxItems: 2, description });

const parameters = Type.Object({
  action: stringEnum(computerActions, "What to do."),
  coordinate: Type.Optional(
    coordinateSchema("[x, y] in screenshot pixels: where to click, move, scroll, or end a drag."),
  ),
  start_coordinate: Type.Optional(coordinateSchema("[x, y] where a left_click_drag starts.")),
  text: Type.Optional(
    Type.String({
      maxLength: longestTypedText,
      description:
        "For type, the text to type. For key, xdotool key names or combinations separated by spaces, such as Return, ctrl+l or alt+Tab.",
    }),
  ),
  scroll_direction: Type.Optional(
    stringEnum(["up", "down", "left", "right"] as const, "For scroll; down unless given."),
  ),
  scroll_amount: Type.Optional(
    Type.Number({ description: "For scroll, how many wheel clicks; 3 unless given." }),
  ),
  duration: Type.Optional(
    Type.Number({ description: `For wait, seconds to wait, at most ${longestWaitInSeconds}.` }),
  ),
});

export default function computerUseExtension(pi: ExtensionAPI): void {
  const tool = createSandboxComputerTool(readComputerToolSettings(process.env));

  pi.on("context", (event) => {
    const messages = pruneOldScreenshots(event.messages, toolName);
    return messages === undefined ? undefined : { messages };
  });

  pi.registerTool({
    name: toolName,
    label: "Computer",
    description:
      "Use the sandbox's graphical desktop, a Linux display with Firefox available as `firefox`, " +
      "which the user can watch live and may take over. Actions: screenshot; left_click, " +
      "right_click, middle_click, double_click and mouse_move at coordinate; left_click_drag from " +
      "start_coordinate to coordinate; scroll at coordinate (scroll_direction, scroll_amount); " +
      "type (text); key (text, such as Return or ctrl+l); wait (duration). Every action but " +
      "screenshot returns a fresh screenshot taken just after it. Coordinates are pixels of the " +
      "screenshots you are shown.",
    promptSnippet: "Look at and operate the sandbox's graphical desktop and its web browser",
    promptGuidelines: [
      "Use computer with action screenshot before acting on the desktop, and check the screenshot each computer action returns before the next.",
      "To open a web page for the computer tool, start the browser from bash in the background (`firefox URL >/dev/null 2>&1 &`), then use computer.",
      "When computer says the user has taken control of the desktop, do not use its mouse or keyboard until they give it back.",
    ],
    parameters,
    // One mouse and one keyboard: actions must not interleave.
    executionMode: "sequential",
    async execute(_toolCallId, request, signal, _onUpdate, context) {
      if (context.model !== undefined && !context.model.input.includes("image")) {
        return toPiResult({
          text: "The model in use cannot see images, so the computer tool cannot show it the screen. Use a model that accepts images to work with the desktop.",
          isError: true,
        });
      }
      const coordinate = toPair(request.coordinate);
      const startCoordinate = toPair(request.start_coordinate);
      return toPiResult(
        await tool.carryOut(
          {
            ...request,
            coordinate,
            start_coordinate: startCoordinate,
          },
          signal,
        ),
      );
    },
  });
}

/** The schema already asks for exactly two numbers; this only satisfies the types. */
function toPair(values: number[] | undefined): readonly [number, number] | undefined {
  const [x, y] = values ?? [];
  return x === undefined || y === undefined ? undefined : [x, y];
}

/**
 * The screenshot goes to the model as an image. Barrack's history keeps
 * only the words: the supervisor records an image as `[image: image/png]`.
 */
function toPiResult(result: ComputerToolResult) {
  const { screenshot } = result;
  return {
    content: [
      { type: "text" as const, text: result.text },
      ...(screenshot === undefined
        ? []
        : [
            {
              type: "image" as const,
              data: screenshot.png.toString("base64"),
              mimeType: "image/png",
            },
          ]),
    ],
    details: {
      width: screenshot?.width ?? null,
      height: screenshot?.height ?? null,
    },
    isError: result.isError,
  };
}
