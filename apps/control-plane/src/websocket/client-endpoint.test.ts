import { buildClientEndpointPath, closeCodes } from "@barrack/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { allowedTestOrigin, TestControlPlane } from "../test-support/test-control-plane.js";
import { attemptUpgrade } from "../test-support/test-socket.js";

let controlPlane: TestControlPlane;
let threadId: string;

const authenticationTimeoutInMilliseconds = 300;

beforeEach(async () => {
  controlPlane = await TestControlPlane.start({
    clientAuthenticationTimeoutInMilliseconds: authenticationTimeoutInMilliseconds,
  });
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
  it("accepts the upgrade from an allowed origin, and from a native client that sends none", async () => {
    expect(await attemptUpgrade(clientUrl(), { Origin: allowedTestOrigin })).toEqual({
      opened: true,
    });
    expect(await attemptUpgrade(clientUrl(), {})).toEqual({ opened: true });
  });

  it("refuses a client from another origin with HTTP 403", async () => {
    const outcome = await attemptUpgrade(clientUrl(), { Origin: "https://attacker.example" });

    expect(outcome).toMatchObject({ opened: false, statusCode: 403 });
  });

  it("refuses a client whose last seen sequence is not a whole number with HTTP 400", async () => {
    const url = clientUrl().replace("lastSeenSequence=0", "lastSeenSequence=-1");

    const outcome = await attemptUpgrade(url, { Origin: allowedTestOrigin });

    expect(outcome).toMatchObject({ opened: false, statusCode: 400 });
  });

  it("starts the replay once the client has authenticated", async () => {
    const client = await controlPlane.connectClient(threadId);

    expect(client.inbox.messages[0]).toEqual({
      type: "replay_announcement",
      firstSequence: 1,
      lastSequence: 0,
    });
  });

  it("closes a client that sends anything before authenticating, and sends it nothing", async () => {
    const client = await controlPlane.openUnauthenticatedClient(threadId);

    client.sendUserMessage("Let me in");

    expect((await client.closed).closeCode).toBe(closeCodes.notAuthenticated);
    expect(client.inbox.messages).toEqual([]);
  });

  it("closes a client that does not authenticate in time, and sends it nothing", async () => {
    const client = await controlPlane.openUnauthenticatedClient(threadId);

    const closed = await client.closed;

    expect(closed.closeCode).toBe(closeCodes.notAuthenticated);
    expect(client.inbox.messages).toEqual([]);
  });

  it("closes a client whose token is not valid, and sends it nothing", async () => {
    const client = await controlPlane.openUnauthenticatedClient(threadId);

    client.authenticate("not-the-development-token");

    expect((await client.closed).closeCode).toBe(closeCodes.notAuthenticated);
    expect(client.inbox.messages).toEqual([]);
  });

  it("closes a client for a thread that does not exist with threadNotFound", async () => {
    const client = await controlPlane.connectClient("thread-that-was-never-created");

    expect((await client.closed).closeCode).toBe(closeCodes.threadNotFound);
    expect(client.inbox.messages).toEqual([]);
  });

  it("closes a client that sends an invalid message", async () => {
    const client = await controlPlane.connectClient(threadId);

    client.sendRawFrame(JSON.stringify({ type: "send_user_message", text: "" }));

    expect((await client.closed).closeCode).toBe(closeCodes.invalidMessage);
  });
});
