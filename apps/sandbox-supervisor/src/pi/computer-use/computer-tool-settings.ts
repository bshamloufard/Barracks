import type { ComputerToolSettings } from "./computer-tool.js";

/**
 * The computer tool runs inside Pi, which the Pi harness starts with these
 * variables set from the supervisor's desktop configuration
 * (`pi-environment.ts`). Without them there is no desktop to use, and the
 * harness does not load the tool at all.
 */
export function readComputerToolSettings(environment: NodeJS.ProcessEnv): ComputerToolSettings {
  const {
    DISPLAY: display,
    BARRACK_DESKTOP_VNC_PORT: vncPortText,
    BARRACK_DESKTOP_CONTROL_FILE: controlFile,
  } = environment;
  const vncPort = Number(vncPortText);
  if (display === undefined || controlFile === undefined || !Number.isInteger(vncPort)) {
    throw new Error(
      "The computer tool needs DISPLAY, BARRACK_DESKTOP_VNC_PORT and BARRACK_DESKTOP_CONTROL_FILE, which the supervisor sets when the sandbox has a desktop.",
    );
  }
  return { display, vncPort, controlFile };
}
