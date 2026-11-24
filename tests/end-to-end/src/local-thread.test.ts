import type { ControlPlaneToClientMessage } from "@barrack/protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type RunningControlPlane, startControlPlane } from "./support/local-system.js";
import { TestClient } from "./support/test-client.js";
import { createThread } from "./support/threads-api.js";

/**
 * The real control plane and the real sandbox supervisor, each in its own
 * process as they run in production, with the supervisor's scripted fake
 * agent. Threads are created through the control plane's API, which starts
 * each thread's supervisor through the local-process sandbox provider with a
 * token of its own. The test clients speak the protocol over real
 * WebSockets, so these tests cover the whole path from a client to the
 * agent and back.
 *
 * One control plane serves every test; each test creates a thread of its
 * own, so no test depends on another's history.
 */

/** The fake agent quotes a message back one word per step, so a long one gives a long run. */
const longMessage = Array.from({ length: 40 }, (_, index) => `word${index + 1}`).join(" ");

let controlPlane: RunningControlPlane;
const clients: TestClient[] = [];

beforeAll(async () => {
  controlPlane = await startControlPlane({ sandboxes: { kind: "local-process" } });
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

afterAll(async () => {
  await controlPlane?.stop();
});

/** A new thread, and a client watching it once the thread's supervisor has connected. */
async function startThread(): Promise<{ threadId: string; client: TestClient }> {
  const { threadId } = await createThread(controlPlane);
  const client = await connectClient(threadId, 0);
  await client.waitUntilSupervisorIsConnected();
  return { threadId, client };
}

async function connectClient(threadId: string, lastSeenSequence: number): Promise<TestClient> {
  const client = await TestClient.connect(controlPlane, threadId, lastSeenSequence);
  clients.push(client);
  return client;
}

function eventTypesOf(client: TestClient): string[] {
  return client.threadEvents().map((message) => message.event.type);
}

function isStreamFragment(message: ControlPlaneToClientMessage): boolean {
  return message.type === "stream_fragment";
}

describe("one thread, run by the real control plane and supervisor", () => {
  it("records the user's message, the run starting, the reply and the run settling, in order and without gaps", async () => {
    const { client } = await startThread();

    client.send({ type: "send_user_message", text: "Hello, agent" });
    await client.waitUntilRunsHaveSettled(1);

    const threadEvents = client.threadEvents();
    expect(threadEvents.map((message) => message.sequence)).toEqual([1, 2, 3, 4]);
    expect(eventTypesOf(client)).toEqual([
      "user_message",
      "agent_run_started",
      "assistant_message",
      "agent_run_settled",
    ]);
    expect(threadEvents[0]?.event).toMatchObject({ type: "user_message", text: "Hello, agent" });
    expect(threadEvents[3]?.event).toEqual({ type: "agent_run_settled", wasInterrupted: false });
  });

  it("streams the reply's text before recording the completed reply", async () => {
    const { client } = await startThread();

    client.send({ type: "send_user_message", text: "Hello, agent" });
    await client.waitUntilRunsHaveSettled(1);

    const completedReplyIndex = client.messages.findIndex(
      (message) => message.type === "thread_event" && message.event.type === "assistant_message",
    );
    const completedReply = client.messages[completedReplyIndex];
    const fragments = client.messages.filter(isStreamFragment);
    const lastFragmentIndex = client.messages.findLastIndex(isStreamFragment);
    const streamedText = fragments
      .map((message) => (message.type === "stream_fragment" ? message.fragment.appendedText : ""))
      .join("");
    expect(fragments.length).toBeGreaterThan(1);
    expect(lastFragmentIndex).toBeLessThan(completedReplyIndex);
    expect(streamedText).toBe('You said: "Hello, agent"');
    expect(completedReply).toMatchObject({
      event: { content: [{ type: "text", text: streamedText }], endReason: "completed" },
    });
  });

  it("replays the identical history to a client that connects later having seen nothing", async () => {
    const { threadId, client: firstClient } = await startThread();
    firstClient.send({ type: "send_user_message", text: "Please use a [tool]" });
    await firstClient.waitUntilRunsHaveSettled(1);
    const history = firstClient.threadEvents();

    const laterClient = await connectClient(threadId, 0);
    await laterClient.waitUntilSupervisorIsConnected();

    expect(history.map((message) => message.event.type)).toContain("tool_execution_finished");
    expect(laterClient.messages.slice(0, history.length + 1)).toEqual([
      { type: "replay_announcement", firstSequence: 1, lastSequence: history.length },
      ...history,
    ]);
  });

  it("sends a client that reconnects mid-run exactly the events it missed", async () => {
    const { threadId, client: watchingClient } = await startThread();
    const droppingClient = await connectClient(threadId, 0);
    await droppingClient.waitUntilSupervisorIsConnected();

    watchingClient.send({ type: "send_user_message", text: longMessage });
    await droppingClient.waitUntil(
      "the reply has started streaming",
      (messages) => messages.filter(isStreamFragment).length >= 3,
    );
    await droppingClient.close();
    const lastSeenSequence = droppingClient.lastSeenSequence();
    const reconnectedClient = await connectClient(threadId, lastSeenSequence);
    const wasRunStillGoing = !eventTypesOf(watchingClient).includes("agent_run_settled");
    await reconnectedClient.waitUntilRunsHaveSettled(1);
    await watchingClient.waitUntilRunsHaveSettled(1);

    const missedEvents = watchingClient
      .threadEvents()
      .filter((message) => message.sequence > lastSeenSequence);
    expect(wasRunStillGoing).toBe(true);
    expect(reconnectedClient.messages[0]).toMatchObject({
      type: "replay_announcement",
      firstSequence: lastSeenSequence + 1,
    });
    expect(reconnectedClient.threadEvents()).toEqual(missedEvents);
    expect([...droppingClient.threadEvents(), ...reconnectedClient.threadEvents()]).toEqual(
      watchingClient.threadEvents(),
    );
  });

  it("ends a run as interrupted when the user interrupts it", async () => {
    const { client } = await startThread();

    client.send({ type: "send_user_message", text: longMessage });
    await client.waitUntil("the reply has started streaming", (messages) =>
      messages.some(isStreamFragment),
    );
    client.send({ type: "interrupt_agent" });
    await client.waitUntilRunsHaveSettled(1);

    const threadEvents = client.threadEvents();
    expect(eventTypesOf(client)).toEqual([
      "user_message",
      "agent_run_started",
      "assistant_message",
      "agent_run_settled",
    ]);
    expect(threadEvents[2]?.event).toMatchObject({ endReason: "interrupted" });
    expect(threadEvents[3]?.event).toEqual({ type: "agent_run_settled", wasInterrupted: true });
  });
});

describe("two threads created at once", () => {
  it("each get a supervisor of their own, which answers only its own thread", async () => {
    const [first, second] = await Promise.all([startThread(), startThread()]);

    first.client.send({ type: "send_user_message", text: "First thread here" });
    second.client.send({ type: "send_user_message", text: "Second thread here" });
    await Promise.all([
      first.client.waitUntilRunsHaveSettled(1),
      second.client.waitUntilRunsHaveSettled(1),
    ]);

    const repliesIn = (client: TestClient) =>
      client
        .threadEvents()
        .flatMap((message) =>
          message.event.type === "assistant_message" ? message.event.content : [],
        );
    expect(first.threadId).not.toBe(second.threadId);
    expect(repliesIn(first.client)).toEqual([
      { type: "text", text: 'You said: "First thread here"' },
    ]);
    expect(repliesIn(second.client)).toEqual([
      { type: "text", text: 'You said: "Second thread here"' },
    ]);
  });
});
