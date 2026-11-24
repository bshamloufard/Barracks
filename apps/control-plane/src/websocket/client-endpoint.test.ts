import {
  buildClientEndpointPath,
  closeCodes,
  maximumAccessTokenLength,
  maximumUserMessageLength,
} from "@barrack/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { allowedTestOrigin, TestControlPlane } from "../test-support/test-control-plane.js";
import { attemptUpgrade } from "../test-support/test-socket.js";

let controlPlane: TestControlPlane;
let threadId: string;

const authenticationTimeoutInMilliseconds = 300;

/** What a WebSocket reports when its connection ended without a close frame. https://www.rfc-editor.org/rfc/rfc6455#section-7.4.1 */
const abnormalClosure = 1006;

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

  it("drops a client that sends more before authenticating than authenticating needs, without reading the rest", async () => {
    const client = await controlPlane.openUnauthenticatedClient(threadId);
    const frameLargerThanAnyAuthentication = "x".repeat(8 * 1024 * 1024);

    client.sendRawFrame(frameLargerThanAnyAuthentication);

    expect((await client.closed).closeCode).toBe(abnormalClosure);
    expect(client.inbox.messages).toEqual([]);
    expect(controlPlane.logLines.join("\n")).toContain(
      "Dropped a client that sent more before authenticating than authenticating needs",
    );
  });

  it("reads an authenticate message with the longest token allowed, however it is encoded", async () => {
    const client = await controlPlane.openUnauthenticatedClient(threadId);
    // Control characters are the most JSON can make of a character: six bytes each.
    const longestTokenAtItsLargest = "\u0001".repeat(maximumAccessTokenLength);

    client.authenticate(longestTokenAtItsLargest);

    expect((await client.closed).closeCode).toBe(closeCodes.notAuthenticated);
  });

  it("reads a user message of the longest length allowed once the client is attached", async () => {
    const client = await controlPlane.connectClient(threadId);
    const longestMessageAtItsLargest = "€".repeat(maximumUserMessageLength);

    client.sendUserMessage(longestMessageAtItsLargest);

    const recorded = await client.inbox.waitFor(
      "the user's message, recorded",
      (message) => message.type === "thread_event" && message.event.type === "user_message",
    );
    expect(recorded).toMatchObject({ event: { text: longestMessageAtItsLargest } });
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
