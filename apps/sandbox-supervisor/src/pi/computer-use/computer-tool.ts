import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { DesktopControlHolder } from "@barrack/protocol";
import { userHoldsDesktopRefusal } from "../../desktop/computer-tool-refusals.js";
import { parseDesktopControlFile } from "../../desktop/desktop-control-file.js";
import { isVncServerAnswering } from "../../desktop/vnc-server-probe.js";
import {
  type ComputerActionRequest,
  isInputAction,
  longestWaitInSeconds,
  planInput,
} from "./computer-actions.js";
import { encodePng } from "./png-encoder.js";
import { type ScreenGeometry, screenGeometryFor, shrinkFrame } from "./screen-geometry.js";
import { type DisplaySize, readDisplaySize, readFramebuffer } from "./vnc-screen-reader.js";

export type ComputerToolSettings = {
  /** The desktop's X display, such as ":1". */
  display: string;
  vncPort: number;
  /** Where the supervisor says who holds the desktop's input. */
  controlFile: string;
};

/** What the tool did, for the model: words, and the screen as it is now. */
export type ComputerToolResult = {
  text: string;
  isError: boolean;
  screenshot?: { png: Buffer } & DisplaySize;
};

/** The parts that touch the sandbox, replaced in tests. */
export type ComputerToolSystem = {
  readControlHolder(): Promise<DesktopControlHolder>;
  isDesktopAnswering(): Promise<boolean>;
  readDisplaySize(): Promise<DisplaySize>;
  /** The screen, already at the screenshot's size. */
  takeScreenshot(geometry: ScreenGeometry): Promise<{ png: Buffer } & DisplaySize>;
  runXdotool(xdotoolArguments: readonly string[]): Promise<void>;
  sleep(milliseconds: number, signal: AbortSignal | undefined): Promise<void>;
};

/** Long enough for a page to react to a click before the screenshot shows it. */
const settleTimeInMilliseconds = 800;
/** The supervisor restarts a desktop that ended within a few seconds. */
const desktopWaitInMilliseconds = 15_000;
const desktopPollInMilliseconds = 250;
const xdotoolTimeoutInMilliseconds = 60_000;

/**
 * The agent's computer tool, apart from how Pi calls it: takes screenshots,
 * and uses the mouse and keyboard, unless the user holds the desktop's
 * control, when every input action is refused with the reason. Every action
 * but `screenshot` waits a moment and then returns a fresh screenshot, so
 * the model sees what its action did without asking again.
 */
export class ComputerTool {
  readonly #system: ComputerToolSystem;

  constructor(system: ComputerToolSystem) {
    this.#system = system;
  }

  async carryOut(
    request: ComputerActionRequest,
    signal: AbortSignal | undefined,
  ): Promise<ComputerToolResult> {
    if (!(await this.#waitForDesktop(signal))) {
      return {
        text: "The desktop is not running right now; it is being started again. Try again shortly.",
        isError: true,
      };
    }
    const geometry = screenGeometryFor(await this.#system.readDisplaySize());
    const outcome = await this.#act(request, geometry, signal);
    if (outcome.isError) {
      return outcome;
    }
    const screenshot = await this.#system.takeScreenshot(geometry);
    const size = `Screenshot: ${screenshot.width}x${screenshot.height} pixels; give coordinates in them.`;
    return { text: `${outcome.text} ${size}`, isError: false, screenshot };
  }

  async #act(
    request: ComputerActionRequest,
    geometry: ScreenGeometry,
    signal: AbortSignal | undefined,
  ): Promise<ComputerToolResult> {
    const { action } = request;
    if (action === "screenshot") {
      return { text: "Took a screenshot.", isError: false };
    }
    if (action === "wait") {
      const seconds = Math.min(longestWaitInSeconds, Math.max(0, request.duration ?? 1));
      await this.#system.sleep(seconds * 1000, signal);
      return { text: `Waited ${seconds} seconds.`, isError: false };
    }
    if (!isInputAction(action)) {
      return { text: `There is no action "${action}".`, isError: true };
    }
    if ((await this.#system.readControlHolder()) === "user") {
      return { text: userHoldsDesktopRefusal, isError: true };
    }
    let plan: ReturnType<typeof planInput>;
    try {
      plan = planInput({ ...request, action }, geometry);
    } catch (error) {
      return { text: error instanceof Error ? error.message : String(error), isError: true };
    }
    await this.#system.runXdotool(plan.xdotoolArguments);
    await this.#system.sleep(settleTimeInMilliseconds, signal);
    return { text: plan.description, isError: false };
  }

  async #waitForDesktop(signal: AbortSignal | undefined): Promise<boolean> {
    const deadline = Date.now() + desktopWaitInMilliseconds;
    while (!(await this.#system.isDesktopAnswering())) {
      if (Date.now() > deadline) {
        return false;
      }
      await this.#system.sleep(desktopPollInMilliseconds, signal);
    }
    return true;
  }
}

/** The tool as it runs in the sandbox: the local VNC server, xdotool and the control file. */
export function createSandboxComputerTool(settings: ComputerToolSettings): ComputerTool {
  const runCommand = promisify(execFile);
  return new ComputerTool({
    readControlHolder: () => readControlHolder(settings.controlFile),
    isDesktopAnswering: () => isVncServerAnswering(settings.vncPort),
    readDisplaySize: () => readDisplaySize(settings.vncPort),
    takeScreenshot: async (geometry) => {
      const frame = shrinkFrame(await readFramebuffer(settings.vncPort), geometry.screenshot);
      return { png: encodePng(frame), width: frame.width, height: frame.height };
    },
    runXdotool: async (xdotoolArguments) => {
      await runCommand("xdotool", [...xdotoolArguments], {
        env: { ...process.env, DISPLAY: settings.display },
        timeout: xdotoolTimeoutInMilliseconds,
      });
    },
    sleep: sleepUnlessAborted,
  });
}

/** A file that cannot be read leaves the agent in control: the supervisor writes it at its start. */
async function readControlHolder(controlFile: string): Promise<DesktopControlHolder> {
  try {
    return parseDesktopControlFile(await readFile(controlFile, "utf8"));
  } catch {
    return "agent";
  }
}

function sleepUnlessAborted(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("The tool was cancelled."));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("The tool was cancelled."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
