import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ControlPlaneToClientMessage, ThreadEvent } from "@barrack/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RunningControlPlane, startControlPlane } from "./support/local-system.js";
import {
  RestartableSupervisors,
  restartableSupervisorCommand,
} from "./support/restartable-supervisors.js";
import { TestClient } from "./support/test-client.js";
import { createThread } from "./support/threads-api.js";
import {
  createThrowawayDatabase,
  type ThrowawayDatabase,
  testDatabaseUrl,
} from "./support/throwaway-database.js";

/**
 * What happens to a thread when the processes serving it die: the real
 * control plane and the real supervisor, each killed outright with
 * SIGKILL, as a host with no shutdown grace or a crashing sandbox would.
 * The supervisor runs the fake agent inside a stand-in sandbox that can
 * start it again (`support/restartable-supervisor.ts`). With a test
 * database the control plane keeps history in Postgres, as deployed;
 * without one only the tests that need no restart of the control plane run.
 */

/** Makes the fake agent call a tool before it replies; see the supervisor's fake agent. */
const fakeAgentToolTrigger = "[tool]";

/** The fake agent quotes a message back one word per 60 ms step, so this takes about six seconds. */
const longMessage = Array.from({ length: 100 }, (_, index) => `word${index + 1}`).join(" ");

let recordDirectory: string;
let supervisors: RestartableSupervisors;
let database: ThrowawayDatabase | undefined;
/** Every control plane a test started, killed ones included, whose leftovers must still be removed. */
const controlPlanes: RunningControlPlane[] = [];
const clients: TestClient[] = [];

beforeEach(async () => {
  recordDirectory = await mkdtemp(path.join(tmpdir(), "barrack-end-to-end-supervisors-"));
  supervisors = new RestartableSupervisors(recordDirectory);
  database =
    testDatabaseUrl === undefined ? undefined : await createThrowawayDatabase(testDatabaseUrl);
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  // Newest first: the one still running stops the supervisors it started;
  // stopping one that was killed only removes what it left behind.
  for (const running of controlPlanes.splice(0).reverse()) {
    await running.stop();
  }
  await supervisors.stopAll();
  await database?.drop();
  await rm(recordDirectory, { recursive: true, force: true });
});

/** A control plane; given the one it replaces, on that one's port and sandboxes. */
async function startTestControlPlane(
  replacing?: RunningControlPlane,
): Promise<RunningControlPlane> {
  const running = await startControlPlane({
    sandboxes: {
      kind: "local-process",
      supervisorCommand: restartableSupervisorCommand(recordDirectory),
      ...(replacing?.sandboxesDirectory === undefined
        ? {}
        : { sandboxesDirectory: replacing.sandboxesDirectory }),
    },
    ...(replacing === undefined ? {} : { port: replacing.port }),
    ...(database === undefined ? {} : { databaseUrl: database.url }),
  });
  controlPlanes.push(running);
  return running;
}

async function connectClient(
  running: RunningControlPlane,
  threadId: string,
  lastSeenSequence = 0,
): Promise<TestClient> {
  const client = await TestClient.connect(running, threadId, lastSeenSequence);
  clients.push(client);
  return client;
}

/** A new thread with its supervisor connected, and a client watching it. */
async function startThread(running: RunningControlPlane) {
  const { threadId } = await createThread(running);
  const client = await connectClient(running, threadId);
  await client.waitUntilSupervisorIsConnected();
  return { threadId, client };
}

function eventsOf(client: TestClient): ThreadEvent[] {
  return client.threadEvents().map((message) => message.event);
}

function repliesIn(client: TestClient): string[] {
  return eventsOf(client).flatMap((event) =>
    event.type === "assistant_message"
      ? event.content.flatMap((block) => (block.type === "text" ? [block.text] : []))
      : [],
  );
}

function waitUntilStreaming(client: TestClient, fragmentCount: number): Promise<void> {
  return client.waitUntil(`${fragmentCount} fragments have streamed`, (messages) => {
    const fragments = messages.filter((message) => message.type === "stream_fragment");
    return fragments.length >= fragmentCount;
  });
}

function isSupervisorConnected(isConnected: boolean) {
  return (message: ControlPlaneToClientMessage) =>
    message.type === "supervisor_connection_status" &&
    message.isSupervisorConnected === isConnected;
}

describe("a thread whose control plane is killed in the middle of a run", () => {
  it.skipIf(testDatabaseUrl === undefined)(
    "keeps every event exactly once and in order, and the run settles, once a new control plane starts",
    async () => {
      // The agent first streams a short message asking for a tool, then
      // runs it, then streams a long reply. The control plane is killed as
      // the short message starts, so the tool events happen while it is
      // gone and the long reply carries on once a new one is up.
      const message = `${fakeAgentToolTrigger} ${longMessage}`;
      const firstControlPlane = await startTestControlPlane();
      const { threadId, client: clientBeforeKill } = await startThread(firstControlPlane);
      clientBeforeKill.send({ type: "send_user_message", text: message });
      await waitUntilStreaming(clientBeforeKill, 1);

      await firstControlPlane.kill();
      const secondControlPlane = await startTestControlPlane(firstControlPlane);
      const clientAfterRestart = await connectClient(secondControlPlane, threadId);
      await clientAfterRestart.waitUntilRunsHaveSettled(1);

      const history = clientAfterRestart.threadEvents();
      expect(history.map((recorded) => recorded.sequence)).toEqual(
        history.map((_, index) => index + 1),
      );
      expect(eventsOf(clientAfterRestart)).toEqual([
        expect.objectContaining({ type: "user_message", text: message }),
        { type: "agent_run_started" },
        expect.objectContaining({ type: "assistant_message", endReason: "tool_use_requested" }),
        expect.objectContaining({ type: "tool_execution_started", toolName: "echo" }),
        expect.objectContaining({ type: "tool_execution_finished", isError: false }),
        expect.objectContaining({ type: "assistant_message", endReason: "completed" }),
        { type: "agent_run_settled", wasInterrupted: false },
      ]);
      expect(repliesIn(clientAfterRestart)).toEqual([
        "Let me run a tool first.",
        `You said: "${message}"`,
      ]);
      const seenBeforeKill = clientBeforeKill.threadEvents();
      expect(seenBeforeKill.map((recorded) => recorded.event.type)).not.toContain(
        "tool_execution_started",
      );
      expect(history.slice(0, seenBeforeKill.length)).toEqual(seenBeforeKill);
    },
  );
});

describe("a thread whose supervisor is killed in the middle of a run", () => {
  it("has the run closed in its history once a new supervisor starts, and answers the next message", async () => {
    const controlPlane = await startTestControlPlane();
    const { threadId, client } = await startThread(controlPlane);
    client.send({ type: "send_user_message", text: longMessage });
    await waitUntilStreaming(client, 5);

    await supervisors.kill(threadId);
    await client.waitUntil("told the supervisor is gone", (messages) =>
      messages.some(isSupervisorConnected(false)),
    );
    await supervisors.restart(threadId);
    await client.waitUntil("the abandoned run is closed", () =>
      eventsOf(client).some((event) => event.type === "agent_failed"),
    );
    client.send({ type: "send_user_message", text: "Are you back?" });
    await client.waitUntilRunsHaveSettled(1);

    const events = eventsOf(client);
    expect(events.map((event) => event.type)).toEqual([
      "user_message",
      "agent_run_started",
      "agent_failed",
      "user_message",
      "agent_run_started",
      "assistant_message",
      "agent_run_settled",
    ]);
    expect(events[2]).toMatchObject({
      type: "agent_failed",
      errorMessage: expect.stringContaining("stopped in the middle of this run"),
    });
    // The message the crashed supervisor had already handed over is not
    // handed to the new one again.
    expect(repliesIn(client)).toEqual(['You said: "Are you back?"']);
  });
});

describe("a message sent while the thread's supervisor is down", () => {
  it("is recorded, shown as waiting, and delivered once the supervisor is back", async () => {
    const controlPlane = await startTestControlPlane();
    const { threadId, client } = await startThread(controlPlane);
    await supervisors.kill(threadId);
    await client.waitUntil("told the supervisor is gone", (messages) =>
      messages.some(isSupervisorConnected(false)),
    );

    client.send({ type: "send_user_message", text: "Anyone there?" });
    await client.waitUntil("the message is recorded", () => eventsOf(client).length === 1);
    const deliveryWhileDown = client.messages.findLast(
      (message) => message.type === "user_message_delivery_status",
    );
    await supervisors.restart(threadId);
    await client.waitUntilRunsHaveSettled(1);
    await client.waitUntil("the message is reported delivered", (messages) =>
      messages.some(
        (message) =>
          message.type === "user_message_delivery_status" && message.deliveredThroughSequence === 1,
      ),
    );

    expect(deliveryWhileDown).toEqual({
      type: "user_message_delivery_status",
      deliveredThroughSequence: 0,
    });
    expect(client.messages.map((message) => message.type)).not.toContain("client_message_rejected");
    expect(repliesIn(client)).toEqual(['You said: "Anyone there?"']);
  });
});
