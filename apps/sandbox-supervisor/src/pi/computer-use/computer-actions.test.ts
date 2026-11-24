import { describe, expect, it } from "vitest";
import { planInput } from "./computer-actions.js";
import { screenGeometryFor, toDisplayPoint } from "./screen-geometry.js";

const sandboxDisplay = screenGeometryFor({ width: 1280, height: 800 });
const largeDisplay = screenGeometryFor({ width: 1920, height: 1080 });

describe("screen geometry", () => {
  it("shows the sandbox's own 1280x800 display at its own size, one pixel to one", () => {
    expect(sandboxDisplay.screenshot).toEqual({ width: 1280, height: 800 });
    expect(toDisplayPoint([400, 383], sandboxDisplay)).toEqual({ x: 400, y: 383 });
  });

  it("shrinks a larger display to fit, keeping its shape, and maps points back onto it", () => {
    expect(largeDisplay.screenshot).toEqual({ width: 1280, height: 720 });
    expect(toDisplayPoint([270, 262], largeDisplay)).toEqual({ x: 405, y: 393 });
    expect(toDisplayPoint([1279, 719], largeDisplay)).toEqual({ x: 1919, y: 1079 });
  });

  it("refuses a point off the screenshot, saying what the screen's bounds are", () => {
    for (const offScreen of [
      [1280, 10],
      [-1, 10],
      [10, 800],
      [Number.NaN, 1],
    ] as const) {
      expect(() => toDisplayPoint(offScreen, sandboxDisplay)).toThrow(
        /off the screen; coordinates go from \(0, 0\) to \(1279, 799\)/,
      );
    }
  });
});

describe("planInput", () => {
  it("moves to the point and clicks the button asked for", () => {
    expect(planInput({ action: "left_click", coordinate: [400, 383] }, sandboxDisplay)).toEqual({
      xdotoolArguments: ["mousemove", "400", "383", "click", "1"],
      description: "Clicked the left button at (400, 383).",
    });
    expect(
      planInput({ action: "right_click", coordinate: [1, 2] }, sandboxDisplay).xdotoolArguments,
    ).toEqual(["mousemove", "1", "2", "click", "3"]);
    expect(
      planInput({ action: "double_click", coordinate: [1, 2] }, sandboxDisplay).xdotoolArguments,
    ).toEqual(["mousemove", "1", "2", "click", "--repeat", "2", "--delay", "80", "1"]);
  });

  it("clicks where the model pointed on the screenshot, on a display larger than it", () => {
    const plan = planInput({ action: "left_click", coordinate: [270, 262] }, largeDisplay);

    expect(plan.xdotoolArguments).toEqual(["mousemove", "405", "393", "click", "1"]);
    expect(plan.description).toBe("Clicked the left button at (270, 262).");
  });

  it("drags from the start to the end with the left button held", () => {
    const plan = planInput(
      { action: "left_click_drag", start_coordinate: [10, 20], coordinate: [30, 40] },
      sandboxDisplay,
    );

    expect(plan.xdotoolArguments).toEqual([
      ...["mousemove", "10", "20", "mousedown", "1"],
      ...["mousemove", "30", "40", "mouseup", "1"],
    ]);
  });

  it("scrolls with the wheel's buttons, three clicks down unless told otherwise", () => {
    expect(
      planInput({ action: "scroll", coordinate: [5, 5] }, sandboxDisplay).xdotoolArguments,
    ).toEqual(["mousemove", "5", "5", "click", "--repeat", "3", "--delay", "50", "5"]);
    expect(
      planInput(
        { action: "scroll", coordinate: [5, 5], scroll_direction: "up", scroll_amount: 2 },
        sandboxDisplay,
      ).xdotoolArguments.at(-1),
    ).toBe("4");
  });

  it("types text after the end of xdotool's options, and says how much without repeating it", () => {
    const plan = planInput({ action: "type", text: "--not-an-option" }, sandboxDisplay);

    expect(plan.xdotoolArguments).toEqual(["type", "--delay", "12", "--", "--not-an-option"]);
    expect(plan.description).toBe("Typed 15 characters.");
  });

  it("presses keys and combinations given by name", () => {
    expect(planInput({ action: "key", text: "ctrl+l Return" }, sandboxDisplay)).toEqual({
      xdotoolArguments: ["key", "--", "ctrl+l", "Return"],
      description: "Pressed ctrl+l Return.",
    });
  });

  it("explains what an action lacks or gets wrong, for the model to correct", () => {
    expect(() => planInput({ action: "left_click" }, sandboxDisplay)).toThrow(
      "left_click needs coordinate, as [x, y] in screenshot pixels.",
    );
    expect(() => planInput({ action: "type", text: "" }, sandboxDisplay)).toThrow(/needs the text/);
    expect(() => planInput({ action: "key", text: "ctrl+l; rm" }, sandboxDisplay)).toThrow(
      /key names or combinations/,
    );
    expect(() =>
      planInput({ action: "scroll", coordinate: [1, 1], scroll_amount: 500 }, sandboxDisplay),
    ).toThrow(/scroll_amount/);
  });
});
