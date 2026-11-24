import type { ControlPlaneDesktopMessage } from "@barrack/protocol";
import { pino } from "pino";
import { describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import { DesktopStreamRequests } from "./desktop-stream-requests.js";
import { maximumViewersPerThread, ThreadDesktops } from "./thread-desktops.js";

const silentLogger = pino({ level: "silent" });
const someSocket = {} as WebSocket;

function createDesktops() {
  const sentToSupervisors: Array<{ threadId: string; message: ControlPlaneDesktopMessage }> = [];
  const broadcasts: string[] = [];
  const desktops = new ThreadDesktops({
    channel: () => ({
      sendDesktopMessage: (threadId, message) => {
        sentToSupervisors.push({ threadId, message });
        return true;
      },
      broadcastDesktopControlStatus: (threadId) => broadcasts.push(threadId),
    }),
    logger: silentLogger,
  });
  return { desktops, sentToSupervisors, broadcasts };
}

describe("desktop stream requests", () => {
  it("mint a fresh 32-character hexadecimal identifier for every stream", async () => {
    const requests = new DesktopStreamRequests(50);
    const asked: string[] = [];

    await Promise.all([
      requests.request("thread-1", (streamId) => asked.push(streamId) > 0),
      requests.request("thread-1", (streamId) => asked.push(streamId) > 0),
    ]);

    expect(asked).toHaveLength(2);
    expect(asked.every((streamId) => /^[0-9a-f]{32}$/.test(streamId))).toBe(true);
    expect(asked[0]).not.toBe(asked[1]);
  });

  it("hand the stream to whoever asked, once, and only for the thread it was asked of", async () => {
    const requests = new DesktopStreamRequests(1_000);
    let streamId = "";
    const outcome = requests.request("thread-1", (minted) => {
      streamId = minted;
      return true;
    });

    expect(requests.isAwaited("thread-2", streamId)).toBe(false);
    expect(requests.deliver("thread-2", streamId, someSocket)).toBe(false);
    expect(requests.isAwaited("thread-1", streamId)).toBe(true);
    expect(requests.deliver("thread-1", streamId, someSocket)).toBe(true);
    expect(await outcome).toEqual({ ok: true, streamSocket: someSocket });
    expect(requests.isAwaited("thread-1", streamId)).toBe(false);
    expect(requests.deliver("thread-1", streamId, someSocket)).toBe(false);
  });

  it("know nothing of an identifier they never minted", () => {
    const requests = new DesktopStreamRequests();

    expect(requests.isAwaited("thread-1", "0".repeat(32))).toBe(false);
  });

  it("give up on a stream not dialled in time, and forget its identifier", async () => {
    const requests = new DesktopStreamRequests(20);
    let streamId = "";

    const outcome = await requests.request("thread-1", (minted) => {
      streamId = minted;
      return true;
    });

    expect(outcome).toEqual({ ok: false, reason: expect.stringMatching(/did not open/) });
    expect(requests.isAwaited("thread-1", streamId)).toBe(false);
  });

  it("give up at once when the sandbox is not connected, or says it cannot open the stream", async () => {
    const requests = new DesktopStreamRequests(1_000);
    let streamId = "";

    const notConnected = await requests.request("thread-1", () => false);
    const failing = requests.request("thread-1", (minted) => {
      streamId = minted;
      return true;
    });
    requests.fail("thread-2", streamId, "not yours to fail");
    requests.fail("thread-1", streamId, "The desktop is not answering.");

    expect(notConnected).toEqual({ ok: false, reason: expect.stringMatching(/not connected/) });
    expect(await failing).toEqual({ ok: false, reason: "The desktop is not answering." });
  });
});

describe("thread desktops", () => {
  it("admit as many viewers of a thread as allowed, and no more", () => {
    const { desktops } = createDesktops();

    const admissions = Array.from({ length: maximumViewersPerThread + 1 }, (_, index) =>
      desktops.admitViewer("thread-1", { viewerId: `viewer-${index}` }),
    );

    expect(admissions).toEqual([...Array(maximumViewersPerThread).fill(true), false]);
    expect(desktops.admitViewer("thread-2", { viewerId: "viewer-x" })).toBe(true);
  });

  it("give control to one viewer at a time, telling the supervisor and the clients", () => {
    const { desktops, sentToSupervisors, broadcasts } = createDesktops();
    desktops.admitViewer("thread-1", { viewerId: "laptop" });
    desktops.admitViewer("thread-1", { viewerId: "phone" });

    desktops.takeControl("thread-1", "laptop");
    desktops.takeControl("thread-1", "phone");

    expect(desktops.controllingViewerOf("thread-1")).toBe("phone");
    expect(desktops.isControlling("thread-1", "laptop")).toBe(false);
    expect(desktops.controlHolderOf("thread-1")).toBe("user");
    // The agent was told once; moving control between viewers does not concern it.
    expect(sentToSupervisors).toEqual([
      { threadId: "thread-1", message: { type: "desktop_control", holder: "user" } },
    ]);
    expect(broadcasts).toEqual(["thread-1", "thread-1"]);
  });

  it("give control back to the agent when its holder releases it, and only its holder", () => {
    const { desktops, sentToSupervisors } = createDesktops();
    desktops.admitViewer("thread-1", { viewerId: "laptop" });
    desktops.admitViewer("thread-1", { viewerId: "phone" });
    desktops.takeControl("thread-1", "laptop");

    desktops.releaseControl("thread-1", "phone");
    expect(desktops.controllingViewerOf("thread-1")).toBe("laptop");
    desktops.releaseControl("thread-1", "laptop");

    expect(desktops.controlHolderOf("thread-1")).toBe("agent");
    expect(sentToSupervisors.at(-1)?.message).toEqual({ type: "desktop_control", holder: "agent" });
  });

  it("give control back to the agent when the controlling viewer goes", () => {
    const { desktops } = createDesktops();
    desktops.admitViewer("thread-1", { viewerId: "laptop" });
    desktops.takeControl("thread-1", "laptop");

    desktops.removeViewer("thread-1", "laptop");

    expect(desktops.controllingViewerOf("thread-1")).toBeNull();
  });

  it("let no viewer of another thread, or not admitted, take control", () => {
    const { desktops } = createDesktops();
    desktops.admitViewer("thread-1", { viewerId: "laptop" });

    desktops.takeControl("thread-2", "laptop");
    desktops.takeControl("thread-1", "stranger");

    expect(desktops.controllingViewerOf("thread-1")).toBeNull();
    expect(desktops.controllingViewerOf("thread-2")).toBeNull();
  });

  it("forget what a supervisor reported once it has gone", () => {
    const { desktops } = createDesktops();
    desktops.noteAvailability("thread-1", { status: "running" });

    desktops.noteSupervisorDetached("thread-1");

    expect(desktops.availabilityOf("thread-1")).toBeUndefined();
  });
});
