import {
  buildDesktopStreamEndpointPath,
  buildDesktopViewerEndpointPath,
  buildStopThreadApiPath,
  type ControlPlaneToClientMessage,
  closeCodes,
} from "@barrack/protocol";
import { TestIdentityIssuer } from "@barrack/test-identity-issuer";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FakeDesktopStream,
  TestDesktopViewer,
  waitForStreamRequest,
} from "../test-support/desktop-peers.js";
import {
  allowedTestOrigin,
  TestControlPlane,
  type TestThread,
} from "../test-support/test-control-plane.js";
import type { FakeSupervisor } from "../test-support/test-peers.js";
import { attemptUpgrade } from "../test-support/test-socket.js";

/**
 * The live desktop through the real control plane: a viewer, signed in,
 * opens a thread's desktop; the thread's (fake) supervisor is asked for a
 * stream and dials it with the thread's token; the control plane splices the
 * two. Who may open which desktop, and who may drive it, is decided here.
 */

const ada = { userId: "11111111-1111-4111-8111-111111111111", email: "ada@example.com" };
const grace = { userId: "22222222-2222-4222-8222-222222222222", email: "grace@example.com" };

/** What noVNC sends first: version 3.8, security None, ClientInit not shared. */
const viewerHandshake = Buffer.from("RFB 003.008\n\u0001\u0000", "latin1");
const pointerClick = Buffer.from([5, 1, 0, 10, 0, 20]);
const updateRequest = Buffer.from([3, 1, 0, 0, 0, 0, 5, 0, 3, 32]);

let issuer: TestIdentityIssuer;
let controlPlane: TestControlPlane;
let adaToken: string;
let graceToken: string;
let thread: TestThread;
let supervisor: FakeSupervisor;
const openedPeers: Array<{ close(): Promise<void> }> = [];

beforeEach(async () => {
  issuer = await TestIdentityIssuer.start();
  controlPlane = await TestControlPlane.start({
    authentication: { kind: "test-issuer", issuer },
    clientAuthenticationTimeoutInMilliseconds: 300,
  });
  adaToken = await issuer.mintAccessToken({ ...ada, expiresInSeconds: 3600 });
  graceToken = await issuer.mintAccessToken({ ...grace, expiresInSeconds: 3600 });
  thread = await controlPlane.createThread(adaToken);
  supervisor = await controlPlane.connectSupervisor(thread);
  supervisor.reportDesktop({ status: "running" });
});

afterEach(async () => {
  await Promise.all(openedPeers.splice(0).map((peer) => peer.close()));
  await controlPlane.close();
  await issuer.close();
});

async function openViewer(accessToken: string | null = adaToken, threadId = thread.threadId) {
  const viewer = await TestDesktopViewer.open(
    controlPlane.baseUrl,
    threadId,
    allowedTestOrigin,
    accessToken ?? undefined,
  );
  openedPeers.push(viewer);
  return viewer;
}

async function dialStream(
  streamId: string,
  threadId = thread.threadId,
  token = thread.supervisorToken,
) {
  const stream = await FakeDesktopStream.dial(controlPlane.baseUrl, threadId, streamId, token);
  openedPeers.push(stream);
  return stream;
}

/** Who the supervisor has been told holds the desktop, in order: the agent first, at its welcome. */
function holdersToldToSupervisor(): string[] {
  return supervisor.inbox.messages.flatMap((message) =>
    message.type === "desktop_control" ? [message.holder] : [],
  );
}

function waitUntilSupervisorIsTold(holders: string[]): Promise<void> {
  return supervisor.inbox.waitUntil(
    `the supervisor is told `,
    () => holdersToldToSupervisor().join() === holders.join(),
  );
}

/** A viewer of Ada's thread, spliced to a stream the supervisor dialled, past the VNC handshake. */
async function openSplicedViewer(streamCount = 1) {
  const viewer = await openViewer();
  const stream = await dialStream(await waitForStreamRequest(supervisor, streamCount));
  const viewerId = await viewer.ready();
  if (viewerId === undefined) {
    throw new Error(`The viewer was not spliced: ${JSON.stringify(viewer.messages)}`);
  }
  viewer.sendVnc(viewerHandshake);
  await stream.received.waitUntil("the handshake", (bytes) => bytes.length >= 14);
  return { viewer, stream, viewerId };
}

describe("the desktop of a thread", () => {
  it("reaches its owner's viewer through a stream the sandbox dialled out, both ways", async () => {
    const viewer = await openViewer();
    const streamId = await waitForStreamRequest(supervisor);
    const stream = await dialStream(streamId);

    const viewerId = await viewer.ready();
    stream.sendVnc(Buffer.from("RFB 003.008\n"));
    viewer.sendVnc(viewerHandshake);

    expect(viewerId).toMatch(/^[0-9a-f]{32}$/);
    await viewer.received.waitUntil("the server's version", (bytes) => bytes.length === 12);
    expect(viewer.received.bytes.toString()).toBe("RFB 003.008\n");
    await stream.received.waitUntil("the viewer's handshake", (bytes) => bytes.length === 14);
    // Shared, whatever the viewer asked.
    expect([...stream.received.bytes.subarray(12)]).toEqual([1, 1]);
  });

  it("drops a watching viewer's input, and passes it once that viewer takes control", async () => {
    const { viewer, stream } = await openSplicedViewer();

    viewer.sendVnc(pointerClick);
    viewer.sendVnc(updateRequest);
    await stream.received.waitUntil("the update request", (bytes) => bytes.length === 14 + 10);
    viewer.takeControl();
    await waitUntilSupervisorIsTold(["agent", "user"]);
    viewer.sendVnc(pointerClick);

    await stream.received.waitUntil("the click", (bytes) => bytes.length === 14 + 10 + 6);
    expect([...stream.received.bytes.subarray(14)]).toEqual([...updateRequest, ...pointerClick]);
  });

  it("tells the thread's clients which viewer holds control, and gives it back when released", async () => {
    const client = await controlPlane.connectClient(thread.threadId, 0, adaToken);
    const { viewer, viewerId } = await openSplicedViewer();
    const statuses = () =>
      client.inbox.messages.filter(
        (
          message,
        ): message is Extract<ControlPlaneToClientMessage, { type: "desktop_control_status" }> =>
          message.type === "desktop_control_status",
      );

    viewer.takeControl();
    await client.inbox.waitUntil("told who holds control", () => statuses().length === 2);
    viewer.releaseControl();
    await client.inbox.waitUntil("told it was given back", () => statuses().length === 3);

    expect(statuses().map((status) => status.controllingViewerId)).toEqual([null, viewerId, null]);
    expect(holdersToldToSupervisor()).toEqual(["agent", "user", "agent"]);
  });

  it("lets a second viewer watch while the first holds control, dropping the second's input", async () => {
    const laptop = await openSplicedViewer(1);
    const phone = await openSplicedViewer(2);
    laptop.viewer.takeControl();
    await waitUntilSupervisorIsTold(["agent", "user"]);

    phone.viewer.sendVnc(pointerClick);
    phone.viewer.sendVnc(updateRequest);
    laptop.viewer.sendVnc(pointerClick);

    await phone.stream.received.waitUntil(
      "the phone's update request",
      (bytes) => bytes.length === 24,
    );
    await laptop.stream.received.waitUntil("the laptop's click", (bytes) => bytes.length === 20);
    expect([...phone.stream.received.bytes.subarray(14)]).toEqual([...updateRequest]);
  });

  it("gives control back to the agent when the controlling viewer goes", async () => {
    const { viewer } = await openSplicedViewer();
    viewer.takeControl();
    await waitUntilSupervisorIsTold(["agent", "user"]);

    await viewer.close();

    await waitUntilSupervisorIsTold(["agent", "user", "agent"]);
  });

  it("closes the viewer with desktopStreamEnded when the sandbox's side ends", async () => {
    const { viewer, stream } = await openSplicedViewer();

    await stream.close();

    expect((await viewer.closed).closeCode).toBe(closeCodes.desktopStreamEnded);
  });

  it("closes a viewer that sends something other than VNC", async () => {
    const { viewer } = await openSplicedViewer();

    viewer.sendVnc(Buffer.from([250, 0, 0, 0]));

    expect((await viewer.closed).closeCode).toBe(closeCodes.invalidMessage);
  });

  it("notes the controlling user's input as activity, which keeps the sandbox awake", async () => {
    const { viewer } = await openSplicedViewer();
    const before = (await controlPlane.threadStore.find(thread.threadId))?.lastActivityAt;
    await new Promise((resolve) => setTimeout(resolve, 20));

    viewer.sendVnc(pointerClick);
    viewer.takeControl();
    await waitUntilSupervisorIsTold(["agent", "user"]);
    const afterWatching = (await controlPlane.threadStore.find(thread.threadId))?.lastActivityAt;
    viewer.sendVnc(pointerClick);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const afterInput = (await controlPlane.threadStore.find(thread.threadId))?.lastActivityAt;

    expect(afterWatching).toEqual(before);
    expect(afterInput?.getTime()).toBeGreaterThan(before?.getTime() ?? Number.POSITIVE_INFINITY);
  });
});

describe("a desktop that cannot be shown", () => {
  it("is refused when the sandbox is stopped, saying so, and the sandbox is not woken", async () => {
    await controlPlane.sendApi("POST", buildStopThreadApiPath(thread.threadId), adaToken);
    await controlPlane.whenOperationsSettle();

    const viewer = await openViewer();

    expect((await viewer.closed).closeCode).toBe(closeCodes.desktopUnavailable);
    expect(viewer.messages).toEqual([
      {
        type: "desktop_unavailable",
        reason: "sandbox_not_running",
        explanation: expect.any(String),
      },
    ]);
    expect((await controlPlane.threadStore.find(thread.threadId))?.sandbox.state).toBe("stopped");
  });

  it("is refused when the sandbox reports no desktop, with its explanation", async () => {
    supervisor.reportDesktop({ status: "none", explanation: "This sandbox has no desktop." });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const viewer = await openViewer();

    await viewer.closed;
    expect(viewer.messages).toEqual([
      {
        type: "desktop_unavailable",
        reason: "no_desktop",
        explanation: "This sandbox has no desktop.",
      },
    ]);
  });

  it("is refused when the sandbox says it cannot open the stream", async () => {
    const viewer = await openViewer();
    const streamId = await waitForStreamRequest(supervisor);

    supervisor.sendRawFrame(
      JSON.stringify({
        type: "desktop_stream_failed",
        streamId,
        reason: "The desktop is not answering.",
      }),
    );

    expect((await viewer.closed).closeCode).toBe(closeCodes.desktopUnavailable);
    expect(viewer.messages).toEqual([
      {
        type: "desktop_unavailable",
        reason: "stream_not_opened",
        explanation: "The desktop is not answering.",
      },
    ]);
  });
});

describe("who may open a desktop", () => {
  it("answers another user's thread exactly as one that does not exist", async () => {
    const othersThread = await openViewer(graceToken);
    const missingThread = await openViewer(graceToken, "thread-that-was-never-created");

    const outcomes = await Promise.all([othersThread.closed, missingThread.closed]);

    expect(outcomes.map((outcome) => outcome.closeCode)).toEqual([
      closeCodes.threadNotFound,
      closeCodes.threadNotFound,
    ]);
    expect(othersThread.messages).toEqual([]);
    expect(missingThread.messages).toEqual([]);
    expect(
      supervisor.inbox.messages.some((message) => message.type === "open_desktop_stream"),
    ).toBe(false);
  });

  it("closes a viewer that sends VNC before authenticating, one with a bad token, and one that waits too long", async () => {
    const eager = await openViewer(null);
    eager.sendVnc(viewerHandshake);
    const forged = await openViewer("not-a-token");
    const silent = await openViewer(null);

    const outcomes = await Promise.all([eager.closed, forged.closed, silent.closed]);

    expect(outcomes.map((outcome) => outcome.closeCode)).toEqual([
      closeCodes.notAuthenticated,
      closeCodes.notAuthenticated,
      closeCodes.authenticationTimedOut,
    ]);
    expect(
      supervisor.inbox.messages.some((message) => message.type === "open_desktop_stream"),
    ).toBe(false);
  });

  it("refuses a viewer from an origin that is not allowed", async () => {
    const path = buildDesktopViewerEndpointPath({ threadId: thread.threadId });

    const outcome = await attemptUpgrade(`${controlPlane.baseUrl}${path}`, {
      Origin: "https://attacker.example",
    });

    expect(outcome).toMatchObject({ opened: false, statusCode: 403 });
  });

  it("closes the desktop when the viewer's token expires", async () => {
    const shortToken = await issuer.mintAccessToken({ ...ada, expiresInSeconds: 2 });
    const viewer = await openViewer(shortToken);
    await dialStream(await waitForStreamRequest(supervisor));
    await viewer.ready();

    expect((await viewer.closed).closeCode).toBe(closeCodes.accessTokenExpired);
  });
});

describe("who may open a desktop stream", () => {
  function streamUrl(threadId: string, streamId: string) {
    return `${controlPlane.baseUrl}${buildDesktopStreamEndpointPath({ threadId, streamId })}`;
  }

  it("refuses a stream nobody asked for, even with the thread's token", async () => {
    const outcome = await attemptUpgrade(streamUrl(thread.threadId, "0".repeat(32)), {
      Authorization: `Bearer ${thread.supervisorToken}`,
    });

    expect(outcome).toMatchObject({ opened: false, statusCode: 401 });
  });

  it("refuses a stream asked of one thread when another thread's supervisor dials it", async () => {
    const otherThread = await controlPlane.createThread(adaToken);
    await openViewer();
    const streamId = await waitForStreamRequest(supervisor);

    const underOtherThread = await attemptUpgrade(streamUrl(otherThread.threadId, streamId), {
      Authorization: `Bearer ${otherThread.supervisorToken}`,
    });
    const withOtherToken = await attemptUpgrade(streamUrl(thread.threadId, streamId), {
      Authorization: `Bearer ${otherThread.supervisorToken}`,
    });
    const withoutToken = await attemptUpgrade(streamUrl(thread.threadId, streamId), {});

    expect([underOtherThread, withOtherToken, withoutToken]).toEqual([
      expect.objectContaining({ opened: false, statusCode: 401 }),
      expect.objectContaining({ opened: false, statusCode: 401 }),
      expect.objectContaining({ opened: false, statusCode: 401 }),
    ]);
  });

  it("accepts the stream asked for once, and refuses it a second time", async () => {
    await openViewer();
    const streamId = await waitForStreamRequest(supervisor);
    await dialStream(streamId);

    const again = await attemptUpgrade(streamUrl(thread.threadId, streamId), {
      Authorization: `Bearer ${thread.supervisorToken}`,
    });

    expect(again).toMatchObject({ opened: false, statusCode: 401 });
  });
});
