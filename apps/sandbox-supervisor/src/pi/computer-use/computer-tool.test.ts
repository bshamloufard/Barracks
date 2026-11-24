import type { DesktopControlHolder } from "@barrack/protocol";
import { describe, expect, it } from "vitest";
import { userHoldsDesktopRefusal } from "../../desktop/computer-tool-refusals.js";
import { ComputerTool, type ComputerToolSystem } from "./computer-tool.js";

type FakeSystem = ComputerToolSystem & {
  holder: DesktopControlHolder;
  isAnswering: boolean;
  xdotoolCalls: string[][];
  screenshotsTaken: number;
  sleeps: number[];
};

function createFakeSystem(display = { width: 1280, height: 800 }): FakeSystem {
  const system: FakeSystem = {
    holder: "agent",
    isAnswering: true,
    xdotoolCalls: [],
    screenshotsTaken: 0,
    sleeps: [],
    readControlHolder: async () => system.holder,
    isDesktopAnswering: async () => system.isAnswering,
    readDisplaySize: async () => display,
    takeScreenshot: async (geometry) => {
      system.screenshotsTaken += 1;
      return { png: Buffer.from("png"), ...geometry.screenshot };
    },
    runXdotool: async (xdotoolArguments) => {
      system.xdotoolCalls.push([...xdotoolArguments]);
    },
    sleep: async (milliseconds) => {
      system.sleeps.push(milliseconds);
    },
  };
  return system;
}

describe("the computer tool", () => {
  it("clicks where asked and shows the screen as it is afterwards", async () => {
    const system = createFakeSystem();
    const tool = new ComputerTool(system);

    const result = await tool.carryOut({ action: "left_click", coordinate: [400, 383] }, undefined);

    expect(system.xdotoolCalls).toEqual([["mousemove", "400", "383", "click", "1"]]);
    expect(result).toEqual({
      text: "Clicked the left button at (400, 383). Screenshot: 1280x800 pixels; give coordinates in them.",
      isError: false,
      screenshot: { png: Buffer.from("png"), width: 1280, height: 800 },
    });
  });

  it("clicks on the display where the model pointed on a shrunk screenshot", async () => {
    const system = createFakeSystem({ width: 1920, height: 1080 });
    const tool = new ComputerTool(system);

    const result = await tool.carryOut({ action: "left_click", coordinate: [270, 262] }, undefined);

    expect(system.xdotoolCalls).toEqual([["mousemove", "405", "393", "click", "1"]]);
    expect(result.screenshot).toMatchObject({ width: 1280, height: 720 });
  });

  it("refuses every input action while the user holds the desktop, touching nothing", async () => {
    const system = createFakeSystem();
    system.holder = "user";
    const tool = new ComputerTool(system);

    for (const request of [
      { action: "left_click", coordinate: [1, 1] },
      { action: "type", text: "hello" },
      { action: "key", text: "Return" },
      { action: "scroll", coordinate: [1, 1] },
      { action: "mouse_move", coordinate: [1, 1] },
    ] as const) {
      expect(await tool.carryOut(request, undefined)).toEqual({
        text: userHoldsDesktopRefusal,
        isError: true,
      });
    }
    expect(system.xdotoolCalls).toEqual([]);
    expect(system.screenshotsTaken).toBe(0);
  });

  it("still lets the agent look and wait while the user holds the desktop", async () => {
    const system = createFakeSystem();
    system.holder = "user";
    const tool = new ComputerTool(system);

    const screenshot = await tool.carryOut({ action: "screenshot" }, undefined);
    const wait = await tool.carryOut({ action: "wait", duration: 2 }, undefined);

    expect(screenshot).toMatchObject({ isError: false, text: expect.stringMatching(/^Took a/) });
    expect(wait).toMatchObject({
      isError: false,
      text: expect.stringMatching(/^Waited 2 seconds/),
    });
    expect(system.sleeps).toEqual([2000]);
  });

  it("uses the desktop again once the user gives control back", async () => {
    const system = createFakeSystem();
    system.holder = "user";
    const tool = new ComputerTool(system);
    await tool.carryOut({ action: "key", text: "Return" }, undefined);

    system.holder = "agent";
    const result = await tool.carryOut({ action: "key", text: "Return" }, undefined);

    expect(result.isError).toBe(false);
    expect(system.xdotoolCalls).toEqual([["key", "--", "Return"]]);
  });

  it("answers with the mistake, and takes no screenshot, for an action it cannot carry out", async () => {
    const system = createFakeSystem();
    const tool = new ComputerTool(system);

    const result = await tool.carryOut({ action: "left_click", coordinate: [5000, 1] }, undefined);

    expect(result).toEqual({ text: expect.stringMatching(/off the screen/), isError: true });
    expect(system.screenshotsTaken).toBe(0);
  });

  it("says the desktop is not running when it does not answer for a while", async () => {
    const system = createFakeSystem();
    system.isAnswering = false;
    const tool = new ComputerTool(system);
    const realNow = Date.now;
    let fakeNow = realNow();
    Date.now = () => fakeNow;
    system.sleep = async (milliseconds) => {
      fakeNow += milliseconds;
    };
    try {
      const result = await tool.carryOut({ action: "screenshot" }, undefined);

      expect(result).toEqual({
        text: expect.stringMatching(/^The desktop is not running right now/),
        isError: true,
      });
    } finally {
      Date.now = realNow;
    }
  });
});
