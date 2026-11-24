import type { ControlPlaneToClientMessage } from "@barrack/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RunningControlPlane, startControlPlane } from "./support/local-system.js";
import { TestClient } from "./support/test-client.js";
import {
  createThread,
  requestCreation,
  resumeThread,
  stopThread,
  waitUntilSandboxIs,
} from "./support/threads-api.js";
import {
  createThrowawayDatabase,
  type ThrowawayDatabase,
  testDatabaseUrl,
} from "./support/throwaway-database.js";

/**
 * A thread's sandbox stopped, resumed, woken by a message and stopped for
 * being idle, through the real control plane and the real supervisor (with
 * the fake agent) in local-process sandboxes; and a control plane killed in
 * the middle of a stop or a start, whose successor finishes it. The control
 * plane checks its sandboxes every half second, so an operation a killed
 * control plane left under way is taken over within a second or two.
 */

const lifecycleEnvironment = { BARRACK_SANDBOX_CHECK_SECONDS: "0.5" };

let database: ThrowawayDatabase | undefined;
const controlPlanes: RunningControlPlane[] = [];
const clients: TestClient[] = [];

beforeEach(async () => {
  database =
    testDatabaseUrl === undefined ? undefined : await createThrowawayDatabase(testDatabaseUrl);
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  for (const running of controlPlanes.splice(0).reverse()) {
    await running.stop();
  }
  await database?.drop();
});

/** A control plane; given the one it replaces, on that one's port and sandboxes. */
async function startTestControlPlane(
  options: { replacing?: RunningControlPlane; environment?: NodeJS.ProcessEnv } = {},
): Promise<RunningControlPlane> {
  const { replacing } = options;
  const running = await startControlPlane({
    sandboxes: {
      kind: "local-process",
      ...(replacing?.sandboxesDirectory === undefined
        ? {}
        : { sandboxesDirectory: replacing.sandboxesDirectory }),
    },
    environment: { ...lifecycleEnvironment, ...options.environment },
    ...(replacing === undefined ? {} : { port: replacing.port }),
    ...(database === undefined ? {} : { databaseUrl: database.url }),
  });
  controlPlanes.push(running);
  return running;
}

async function connectClient(running: RunningControlPlane, threadId: string): Promise<TestClient> {
  const client = await TestClient.connect(running, threadId, 0);
  clients.push(client);
  return client;
}

function supervisorIs(isConnected: boolean) {
  return (messages: readonly ControlPlaneToClientMessage[]): boolean => {
    const status = messages.findLast((message) => message.type === "supervisor_connection_status");
    return (
      status?.type === "supervisor_connection_status" &&
      status.isSupervisorConnected === isConnected
    );
  };
}

function repliesIn(client: TestClient): string[] {
  return client
    .threadEvents()
    .flatMap(({ event }) =>
      event.type === "assistant_message"
        ? event.content.flatMap((block) => (block.type === "text" ? [block.text] : []))
        : [],
    );
}

/** A thread whose agent has answered one message, with a client watching it. */
async function startAnsweredThread(running: RunningControlPlane) {
  const { threadId } = await createThread(running);
  const client = await connectClient(running, threadId);
  await client.waitUntil("the supervisor has connected", supervisorIs(true));
  client.sendUserMessage("First task");
  await client.waitUntilRunsHaveSettled(1);
  return { threadId, client };
}

describe("stopping and resuming a thread", () => {
  it("stops its sandbox, starts it again, and the agent answers the next message", async () => {
    const running = await startTestControlPlane();
    const { threadId, client } = await startAnsweredThread(running);

    expect((await stopThread(running, threadId)).status).toBe(202);
    await waitUntilSandboxIs(running, threadId, "stopped");
    await client.waitUntil("the supervisor has gone", supervisorIs(false));
    expect((await resumeThread(running, threadId)).status).toBe(202);
    await waitUntilSandboxIs(running, threadId, "running");
    await client.waitUntil("the supervisor is back", supervisorIs(true));
    client.sendUserMessage("Second task");
    await client.waitUntilRunsHaveSettled(2);

    expect(repliesIn(client)).toEqual(['You said: "First task"', 'You said: "Second task"']);
  });
});

describe("a message to a thread whose sandbox is stopped", () => {
  it("wakes the sandbox and is answered once the agent is back, without the user resuming it", async () => {
    const running = await startTestControlPlane();
    const { threadId, client } = await startAnsweredThread(running);
    await stopThread(running, threadId);
    await waitUntilSandboxIs(running, threadId, "stopped");

    client.sendUserMessage("Wake up");
    await waitUntilSandboxIs(running, threadId, "running");
    await client.waitUntilRunsHaveSettled(2);

    expect(repliesIn(client)).toEqual(['You said: "First task"', 'You said: "Wake up"']);
  });
});

describe("the limit on running sandboxes", () => {
  it("refuses a thread beyond it, naming the running one, and admits one once that has stopped", async () => {
    const running = await startTestControlPlane({
      environment: { BARRACK_RUNNING_SANDBOXES_PER_USER: "1" },
    });
    const { threadId } = await startAnsweredThread(running);

    const refused = await requestCreation(running);
    await stopThread(running, threadId);
    await waitUntilSandboxIs(running, threadId, "stopped");
    const admitted = await requestCreation(running);

    expect(refused).toEqual({
      status: 409,
      errorCode: "sandbox_limit_reached",
      message:
        'You already have 1 sandbox running, the most allowed at once, so a new thread cannot start. Stop one of yours first: "First task" (running).',
    });
    expect(admitted.status).toBe(201);
  });
});

describe("idle shutdown", () => {
  it("stops a sandbox left idle for the configured period, which a message then wakes", async () => {
    const running = await startTestControlPlane({
      environment: { BARRACK_SANDBOX_IDLE_MINUTES: "0.05" },
    });
    const { threadId, client } = await startAnsweredThread(running);

    await waitUntilSandboxIs(running, threadId, "stopped");
    client.sendUserMessage("Back again");
    await client.waitUntilRunsHaveSettled(2);

    expect(repliesIn(client).at(-1)).toBe('You said: "Back again"');
  });
});

describe("a control plane killed in the middle of", () => {
  it.skipIf(testDatabaseUrl === undefined)(
    "a stop has the stop finished by its successor, and the thread resumes",
    async () => {
      const first = await startTestControlPlane();
      const { threadId } = await startAnsweredThread(first);

      expect((await stopThread(first, threadId)).status).toBe(202);
      await first.kill();
      const second = await startTestControlPlane({ replacing: first });
      await waitUntilSandboxIs(second, threadId, "stopped");
      await resumeThread(second, threadId);
      await waitUntilSandboxIs(second, threadId, "running");
      const client = await connectClient(second, threadId);
      await client.waitUntil("the supervisor is back", supervisorIs(true));
      client.sendUserMessage("After the restart");
      await client.waitUntilRunsHaveSettled(2);

      expect(repliesIn(client).at(-1)).toBe('You said: "After the restart"');
    },
  );

  it.skipIf(testDatabaseUrl === undefined)(
    "a start has the start finished by its successor, and the agent answers",
    async () => {
      const first = await startTestControlPlane();
      const { threadId } = await startAnsweredThread(first);
      await stopThread(first, threadId);
      await waitUntilSandboxIs(first, threadId, "stopped");

      expect((await resumeThread(first, threadId)).status).toBe(202);
      await first.kill();
      const second = await startTestControlPlane({ replacing: first });
      await waitUntilSandboxIs(second, threadId, "running");
      const client = await connectClient(second, threadId);
      await client.waitUntil("the supervisor is back", supervisorIs(true));
      client.sendUserMessage("After the restart");
      await client.waitUntilRunsHaveSettled(2);

      expect(repliesIn(client).at(-1)).toBe('You said: "After the restart"');
    },
  );
});
