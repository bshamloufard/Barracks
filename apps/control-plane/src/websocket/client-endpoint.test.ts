import { buildClientEndpointPath, closeCodes } from "@barrack/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { allowedTestOrigin, TestControlPlane } from "../test-support/test-control-plane.js";
import { attemptUpgrade } from "../test-support/test-socket.js";

let controlPlane: TestControlPlane;
let threadId: string;

beforeEach(async () => {
  controlPlane = await TestControlPlane.start();
  ({ threadId } = await controlPlane.createThread());
});

afterEach(async () => {
  await controlPlane.close();
});

function clientUrl(threadToView = threadId): string {
  const path = buildClientEndpointPath({ threadId: threadToView, lastSeenSequence: 0 });
  return `${controlPlane.baseUrl}${path}`;
}

describe("the client endpoint", () => {
  it("accepts a client from an allowed origin", async () => {
    const outcome = await attemptUpgrade(clientUrl(), { Origin: allowedTestOrigin });

    expect(outcome).toEqual({ opened: true });
  });

  it("refuses a client from another origin with HTTP 403", async () => {
    const outcome = await attemptUpgrade(clientUrl(), { Origin: "https://attacker.example" });

    expect(outcome).toMatchObject({ opened: false, statusCode: 403 });
  });

  it("refuses a client that sends no origin with HTTP 403", async () => {
    const outcome = await attemptUpgrade(clientUrl(), {});

    expect(outcome).toMatchObject({ opened: false, statusCode: 403 });
  });

  it("refuses a client for a thread that does not exist with HTTP 404", async () => {
    const outcome = await attemptUpgrade(clientUrl("thread-that-was-never-created"), {
      Origin: allowedTestOrigin,
    });

    expect(outcome).toMatchObject({ opened: false, statusCode: 404 });
  });

  it("refuses a client whose last seen sequence is not a whole number with HTTP 400", async () => {
    const url = clientUrl().replace("lastSeenSequence=0", "lastSeenSequence=-1");

    const outcome = await attemptUpgrade(url, { Origin: allowedTestOrigin });

    expect(outcome).toMatchObject({ opened: false, statusCode: 400 });
  });

  it("closes a client that sends an invalid message", async () => {
    const client = await controlPlane.connectClient(threadId);

    client.sendRawFrame(JSON.stringify({ type: "send_user_message", text: "" }));

    expect((await client.closed).closeCode).toBe(closeCodes.invalidMessage);
  });
});
