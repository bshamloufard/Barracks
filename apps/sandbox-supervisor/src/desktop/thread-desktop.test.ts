import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SupervisorDesktopMessage } from "@barrack/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SameUserAgentLauncher } from "../agent-process/same-user-agent-launcher.js";
import { createSilentLogger } from "../test-support/silent-logger.js";
import {
  startTestControlPlane,
  type TestControlPlane,
} from "../test-support/test-control-plane.js";
import { pause, waitUntil } from "../test-support/wait-until.js";
import { maximumOpenDesktopStreams } from "./desktop-streams.js";
import { ThreadDesktop } from "./thread-desktop.js";

const streamIds = Array.from({ length: 6 }, (_, index) => `${index}`.repeat(32));

let directory: string;
let controlPlane: TestControlPlane;
let vncServer: Server;
let vncPort: number;
/** What the fake VNC server's connections received, one entry per connection. */
let vncReceived: Buffer[];
let reports: SupervisorDesktopMessage[];
let desktop: ThreadDesktop;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "barrack-thread-desktop-"));
  controlPlane = await startTestControlPlane();
  vncReceived = [];
  vncServer = createServer((socket: Socket) => {
    const index = vncReceived.push(Buffer.alloc(0)) - 1;
    socket.on("data", (chunk) => {
      vncReceived[index] = Buffer.concat([vncReceived[index] ?? Buffer.alloc(0), chunk]);
    });
    socket.on("error", () => {});
    socket.write("RFB 003.008\n");
  });
  await new Promise<void>((resolve) => vncServer.listen(0, "127.0.0.1", resolve));
  const address = vncServer.address();
  vncPort = typeof address === "object" && address !== null ? address.port : 0;
  reports = [];
});

afterEach(async () => {
  await desktop?.stop();
  await controlPlane.close();
  await new Promise((resolve) => vncServer.close(resolve));
  await rm(directory, { recursive: true, force: true });
});

function createDesktop(withDesktop = true): ThreadDesktop {
  desktop = new ThreadDesktop({
    configuration: withDesktop
      ? {
          command: path.join(directory, "no-such-desktop"),
          display: ":97",
          vncPort,
          controlFile: path.join(directory, "control"),
        }
      : undefined,
    controlPlaneUrl: controlPlane.url,
    threadId: "thread-1",
    supervisorToken: "token-1",
    launcher: new SameUserAgentLauncher(),
    sourceEnvironment: {},
    sendDesktopMessage: (message) => reports.push(message) > 0,
    logger: createSilentLogger(),
    timing: { firstRestartDelayInMilliseconds: 60_000 },
  });
  return desktop;
}

/** The control file's contents once they are `expected`, or as they are after a second. */
async function readControlFileOnceWritten(expected: string): Promise<string> {
  let contents = "";
  for (let attempt = 0; attempt < 100 && contents !== expected; attempt += 1) {
    contents = await readFile(path.join(directory, "control"), "utf8").catch(() => "");
    await pause(10);
  }
  return contents;
}

describe("the supervisor's desktop streams", () => {
  it("dial the stream asked for, with the thread's token, and join it to the VNC server both ways", async () => {
    createDesktop().handle({ type: "open_desktop_stream", streamId: streamIds[0] ?? "" });

    await waitUntil(() => controlPlane.connections.length === 1, "the stream is dialled");
    const streamSocket = controlPlane.connections[0];
    streamSocket?.send(Buffer.from("RFB 003.008\n"));
    // The test control plane keeps every frame it cannot parse, VNC data included.
    await waitUntil(
      () => controlPlane.receivedFrames.includes("RFB 003.008\n"),
      "the server's greeting",
    );
    await waitUntil(() => vncReceived[0]?.length === 12, "the viewer's version");

    expect(controlPlane.upgradeRequests).toEqual([
      {
        path: `/threads/thread-1/desktop-streams/${streamIds[0]}?protocolVersion=5`,
        authorization: "Bearer token-1",
      },
    ]);
    expect(vncReceived[0]?.toString()).toBe("RFB 003.008\n");
  });

  it("tell the control plane when the desktop does not answer", async () => {
    await new Promise((resolve) => vncServer.close(resolve));
    vncServer = createServer();
    await new Promise<void>((resolve) => vncServer.listen(0, "127.0.0.1", resolve));
    createDesktop();
    await new Promise((resolve) => vncServer.close(resolve));

    desktop.handle({ type: "open_desktop_stream", streamId: streamIds[0] ?? "" });

    await waitUntil(
      () => reports.some((report) => report.type === "desktop_stream_failed"),
      "a failure",
    );
    expect(controlPlane.upgradeRequests).toEqual([]);
  });

  it(`open no more than ${maximumOpenDesktopStreams} at once, whatever the control plane asks`, async () => {
    createDesktop();

    for (const streamId of streamIds.slice(0, maximumOpenDesktopStreams + 1)) {
      desktop.handle({ type: "open_desktop_stream", streamId });
    }

    await waitUntil(
      () => controlPlane.connections.length === maximumOpenDesktopStreams,
      "the streams allowed are dialled",
    );
    expect(reports).toEqual([
      {
        type: "desktop_stream_failed",
        streamId: streamIds[maximumOpenDesktopStreams],
        reason: expect.stringMatching(/already has 4 desktop streams/),
      },
    ]);
  });

  it("are refused, saying why, in a sandbox without a desktop", () => {
    createDesktop(false).handle({ type: "open_desktop_stream", streamId: streamIds[0] ?? "" });

    expect(reports).toEqual([
      {
        type: "desktop_stream_failed",
        streamId: streamIds[0],
        reason: expect.stringMatching(/no desktop/),
      },
    ]);
  });
});

describe("the supervisor's record of who holds the desktop", () => {
  it("gives the agent control at the start, whatever an earlier supervisor left written", async () => {
    await writeFile(path.join(directory, "control"), "user\n");

    await createDesktop().start();

    expect(await readFile(path.join(directory, "control"), "utf8")).toBe("agent\n");
    expect(desktop.controlHolder).toBe("agent");
  });

  it("writes whoever the control plane says holds it", async () => {
    await createDesktop().start();

    desktop.handle({ type: "desktop_control", holder: "user" });

    expect(desktop.controlHolder).toBe("user");
    expect(await readControlFileOnceWritten("user\n")).toBe("user\n");
  });
});
