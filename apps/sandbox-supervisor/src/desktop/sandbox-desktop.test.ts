import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DesktopAvailability } from "@barrack/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SameUserAgentLauncher } from "../agent-process/same-user-agent-launcher.js";
import { createSilentLogger } from "../test-support/silent-logger.js";
import { waitUntil } from "../test-support/wait-until.js";
import { noDesktopExplanation, SandboxDesktop } from "./sandbox-desktop.js";
import { isVncServerAnswering } from "./vnc-server-probe.js";

/**
 * A stand-in for the image's `barrack-desktop`: a "VNC server" that greets
 * on the port it is given, runs until its standard input closes, and, when
 * told to by its name, ends on its own after a moment, as a crashed X
 * server would.
 */
function fakeDesktopScript(endsOnItsOwn: boolean): string {
  return `#!${process.execPath}
const server = require("node:net").createServer((socket) => socket.end("RFB 003.008\\n"));
server.listen(Number(process.env.BARRACK_DESKTOP_VNC_PORT), "127.0.0.1");
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
${endsOnItsOwn ? "setTimeout(() => process.exit(3), 300);" : ""}
`;
}

const { PATH: searchPath } = process.env;

let directory: string;
let desktop: SandboxDesktop | undefined;
let reports: Array<Omit<DesktopAvailability, "type">>;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "barrack-desktop-"));
  reports = [];
});

afterEach(async () => {
  await desktop?.stop();
  desktop = undefined;
  await rm(directory, { recursive: true, force: true });
});

async function findFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (address === null || typeof address === "string") {
    throw new Error("No port.");
  }
  return address.port;
}

async function startDesktop(options: { endsOnItsOwn: boolean }) {
  const command = path.join(directory, "fake-desktop");
  await writeFile(command, fakeDesktopScript(options.endsOnItsOwn));
  await chmod(command, 0o755);
  const vncPort = await findFreePort();
  desktop = new SandboxDesktop({
    configuration: { command, display: ":97", vncPort, controlFile: path.join(directory, "c") },
    launcher: new SameUserAgentLauncher(),
    sourceEnvironment: {
      PATH: searchPath,
      BARRACK_SUPERVISOR_TOKEN: "not for the desktop",
    },
    workingDirectory: directory,
    logger: createSilentLogger(),
    onAvailabilityChanged: (availability) => reports.push(availability),
    timing: { firstRestartDelayInMilliseconds: 50, probeIntervalInMilliseconds: 20 },
  });
  desktop.start();
  return { vncPort };
}

describe("the sandbox's desktop", () => {
  it("is reported running once its VNC server answers, and ends when the supervisor stops it", async () => {
    const { vncPort } = await startDesktop({ endsOnItsOwn: false });

    await waitUntil(() => reports.some((report) => report.status === "running"), "running");
    await desktop?.stop();

    expect(reports).toEqual([{ status: "running" }]);
    expect(await isVncServerAnswering(vncPort)).toBe(false);
  });

  it("is started again whenever it ends, and reported starting meanwhile", async () => {
    await startDesktop({ endsOnItsOwn: true });

    await waitUntil(
      () => reports.filter((report) => report.status === "running").length >= 2,
      "running a second time",
    );

    expect(reports.slice(0, 3)).toEqual([
      { status: "running" },
      {
        status: "starting",
        explanation: expect.stringMatching(/stopped and is being started again/),
      },
      { status: "running" },
    ]);
  });

  it("is reported missing, and nothing is run, in a sandbox without one", () => {
    desktop = new SandboxDesktop({
      configuration: undefined,
      launcher: new SameUserAgentLauncher(),
      sourceEnvironment: {},
      workingDirectory: directory,
      logger: createSilentLogger(),
      onAvailabilityChanged: (availability) => reports.push(availability),
    });

    desktop.start();

    expect(reports).toEqual([{ status: "none", explanation: noDesktopExplanation }]);
  });
});
