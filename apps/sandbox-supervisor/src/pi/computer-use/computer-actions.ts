import { type ScreenGeometry, toDisplayPoint } from "./screen-geometry.js";

/**
 * What the computer tool can do, in the shape models are trained on for
 * computer use (one tool, an action and its arguments), and how each input
 * action becomes an `xdotool` command line
 * (https://manpages.ubuntu.com/manpages/noble/man1/xdotool.1.html), which
 * acts through the X server's test extension as a real mouse and keyboard
 * would.
 */

export const inputActions = [
  "left_click",
  "right_click",
  "middle_click",
  "double_click",
  "mouse_move",
  "left_click_drag",
  "scroll",
  "type",
  "key",
] as const;

export const computerActions = ["screenshot", "wait", ...inputActions] as const;

export type InputAction = (typeof inputActions)[number];
export type ComputerAction = (typeof computerActions)[number];
export type ScrollDirection = "up" | "down" | "left" | "right";
export type Coordinate = readonly [number, number];

export type ComputerActionRequest = {
  action: ComputerAction;
  coordinate?: Coordinate | undefined;
  start_coordinate?: Coordinate | undefined;
  text?: string | undefined;
  scroll_direction?: ScrollDirection | undefined;
  scroll_amount?: number | undefined;
  duration?: number | undefined;
};

/** What carrying out an input action means: the command, and how to say what was done. */
export type InputPlan = { xdotoolArguments: string[]; description: string };

/** Typing goes at a human pace (`--delay`), so a long text would hold the tool for minutes. */
export const longestTypedText = 2_000;
const typingDelayInMilliseconds = "12";
const longestKeySequence = 16;
const defaultScrollAmount = 3;
const largestScrollAmount = 30;
export const longestWaitInSeconds = 30;

export function isInputAction(action: ComputerAction): action is InputAction {
  return (inputActions as readonly string[]).includes(action);
}

const mouseButtons = { left: "1", middle: "2", right: "3" } as const;

/** X's wheel is buttons 4 to 7. */
const scrollButtons: Record<ScrollDirection, string> = {
  up: "4",
  down: "5",
  left: "6",
  right: "7",
};

/**
 * Turns an input action into an `xdotool` command, with coordinates mapped
 * from the screenshot to the display. Throws, with a message the model can
 * act on, when the action lacks what it needs or asks for something off
 * the screen.
 */
export function planInput(
  request: ComputerActionRequest & { action: InputAction },
  geometry: ScreenGeometry,
): InputPlan {
  switch (request.action) {
    case "left_click":
    case "right_click":
    case "middle_click":
    case "double_click":
      return planClick(request, geometry);
    case "mouse_move": {
      const { x, y, where } = pointFor(request.coordinate, "coordinate", request, geometry);
      return { xdotoolArguments: ["mousemove", x, y], description: `Moved the mouse to ${where}.` };
    }
    case "left_click_drag":
      return planDrag(request, geometry);
    case "scroll":
      return planScroll(request, geometry);
    case "type":
      return planTyping(request.text);
    case "key":
      return planKeys(request.text);
  }
}

function planClick(request: ComputerActionRequest, geometry: ScreenGeometry): InputPlan {
  const { x, y, where } = pointFor(request.coordinate, "coordinate", request, geometry);
  const button =
    request.action === "right_click"
      ? mouseButtons.right
      : request.action === "middle_click"
        ? mouseButtons.middle
        : mouseButtons.left;
  const repeat = request.action === "double_click" ? ["--repeat", "2", "--delay", "80"] : [];
  const what =
    request.action === "double_click"
      ? "Double-clicked"
      : `Clicked the ${request.action.replace("_click", "")} button`;
  return {
    xdotoolArguments: ["mousemove", x, y, "click", ...repeat, button],
    description: `${what} at ${where}.`,
  };
}

function planDrag(request: ComputerActionRequest, geometry: ScreenGeometry): InputPlan {
  const start = pointFor(request.start_coordinate, "start_coordinate", request, geometry);
  const end = pointFor(request.coordinate, "coordinate", request, geometry);
  return {
    xdotoolArguments: [
      ...["mousemove", start.x, start.y, "mousedown", mouseButtons.left],
      ...["mousemove", end.x, end.y, "mouseup", mouseButtons.left],
    ],
    description: `Dragged from ${start.where} to ${end.where}.`,
  };
}

function planScroll(request: ComputerActionRequest, geometry: ScreenGeometry): InputPlan {
  const { x, y, where } = pointFor(request.coordinate, "coordinate", request, geometry);
  const direction = request.scroll_direction ?? "down";
  const amount = Math.round(request.scroll_amount ?? defaultScrollAmount);
  if (amount < 1 || amount > largestScrollAmount) {
    throw new Error(`scroll_amount must be from 1 to ${largestScrollAmount}.`);
  }
  return {
    xdotoolArguments: [
      ...["mousemove", x, y, "click", "--repeat", String(amount), "--delay", "50"],
      scrollButtons[direction],
    ],
    description: `Scrolled ${direction} ${amount} times at ${where}.`,
  };
}

function planTyping(text: string | undefined): InputPlan {
  if (text === undefined || text.length === 0) {
    throw new Error("type needs the text to type.");
  }
  if (text.length > longestTypedText) {
    throw new Error(`type takes at most ${longestTypedText} characters at a time.`);
  }
  return {
    xdotoolArguments: ["type", "--delay", typingDelayInMilliseconds, "--", text],
    description: `Typed ${text.length} character${text.length === 1 ? "" : "s"}.`,
  };
}

/** Key names are xdotool's (X keysyms), such as Return, ctrl+l or alt+Tab, separated by spaces. */
function planKeys(text: string | undefined): InputPlan {
  const keys = (text ?? "").split(/\s+/).filter((key) => key.length > 0);
  if (keys.length === 0) {
    throw new Error("key needs a key name or combination, such as Return or ctrl+l.");
  }
  if (keys.length > longestKeySequence || !keys.every((key) => /^[A-Za-z0-9_+]+$/.test(key))) {
    throw new Error(
      `key takes up to ${longestKeySequence} key names or combinations of letters, digits, _ and +, separated by spaces.`,
    );
  }
  return {
    xdotoolArguments: ["key", "--", ...keys],
    description: `Pressed ${keys.join(" ")}.`,
  };
}

function pointFor(
  coordinate: Coordinate | undefined,
  name: string,
  request: ComputerActionRequest,
  geometry: ScreenGeometry,
): { x: string; y: string; where: string } {
  if (coordinate === undefined) {
    throw new Error(`${request.action} needs ${name}, as [x, y] in screenshot pixels.`);
  }
  const point = toDisplayPoint(coordinate, geometry);
  return { x: String(point.x), y: String(point.y), where: `(${coordinate[0]}, ${coordinate[1]})` };
}
