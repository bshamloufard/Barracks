import { setTimeout as sleep } from "node:timers/promises";
import {
  buildResumeThreadApiPath,
  buildStopThreadApiPath,
  buildThreadApiPath,
  closeCodes,
  threadListResponseSchema,
  threadsApiPath,
} from "@barrack/protocol";
import { TestIdentityIssuer } from "@barrack/test-identity-issuer";
import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PostgresThreadRepositoryStore } from "./repositories/postgres-thread-repository-store.js";
import { agentRunStarted, toolExecutionStarted } from "./test-support/example-agent-events.js";
import {
  browserHeaders,
  TestControlPlane,
  type TestControlPlaneOptions,
  type TestThread,
} from "./test-support/test-control-plane.js";
import {
  createTestPool,
  describeWithTestDatabase,
  TestSchemas,
} from "./test-support/test-database.js";
import type { TestClient } from "./test-support/test-peers.js";
import { PostgresThreadStore } from "./threads/postgres-thread-store.js";
import { InMemoryUserStore } from "./users/in-memory-user-store.js";
import { PostgresUserStore } from "./users/postgres-user-store.js";

/**
 * Who may see and control what, through the real control plane, with tokens
 * from a test identity issuer verified exactly as Supabase's would be.
 * Another user's thread must be indistinguishable from one that does not
 * exist, over HTTP and over the WebSocket.
 */

const ada = { userId: "11111111-1111-4111-8111-111111111111", email: "ada@example.com" };
const grace = { userId: "22222222-2222-4222-8222-222222222222", email: "grace@example.com" };

let issuer: TestIdentityIssuer;
let controlPlane: TestControlPlane;

beforeEach(async () => {
  issuer = await TestIdentityIssuer.start();
});

afterEach(async () => {
  await controlPlane?.close();
  await issuer.close();
});

async function start(options: Omit<TestControlPlaneOptions, "authentication"> = {}) {
  controlPlane = await TestControlPlane.start({
    authentication: { kind: "test-issuer", issuer },
    ...options,
  });
}

function signIn(user: { userId: string; email: string }, expiresInSeconds = 3600) {
  return issuer.mintAccessToken({ ...user, expiresInSeconds });
}

async function listThreadIds(accessToken: string): Promise<string[]> {
  const response = await controlPlane.getApi(threadsApiPath, accessToken);
  expect(response.status).toBe(200);
  const { threads } = threadListResponseSchema.parse(await response.json());
  return threads.map((thread) => thread.threadId);
}

/** Status and body, with the thread's identifier blanked, which the answer names either way. */
async function describeAnswer(response: Response, threadId: string) {
  const body = await response.text();
  return { status: response.status, body: body.replaceAll(threadId, "<thread>") };
}

/** How a WebSocket for the thread ended, and everything it was sent before. */
async function connectAndSend(
  threadId: string,
  accessToken: string,
  send: (client: TestClient) => void,
) {
  const client = await controlPlane.connectClient(threadId, 0, accessToken);
  send(client);
  const { closeCode } = await client.closed;
  return { closeCode, received: client.inbox.messages };
}

describe("each user's threads", () => {
  let adaThread: TestThread;
  let adaToken: string;
  let graceToken: string;

  beforeEach(async () => {
    await start();
    adaToken = await signIn(ada);
    graceToken = await signIn(grace);
    adaThread = await controlPlane.createThread(adaToken);
  });

  it("lists only each user's own threads", async () => {
    const graceThread = await controlPlane.createThread(graceToken);

    expect(await listThreadIds(adaToken)).toEqual([adaThread.threadId]);
    expect(await listThreadIds(graceToken)).toEqual([graceThread.threadId]);
  });

  it("answers fetching another user's thread exactly as fetching one that does not exist", async () => {
    const missingThreadId = "33333333-3333-4333-8333-333333333333";

    const othersThread = await controlPlane.getApi(
      buildThreadApiPath(adaThread.threadId),
      graceToken,
    );
    const missingThread = await controlPlane.getApi(
      buildThreadApiPath(missingThreadId),
      graceToken,
    );

    expect(await describeAnswer(othersThread, adaThread.threadId)).toEqual(
      await describeAnswer(missingThread, missingThreadId),
    );
    expect(othersThread.status).toBe(404);
  });

  it.each([
    ["stopping", "POST", (threadId: string) => buildStopThreadApiPath(threadId)],
    ["resuming", "POST", (threadId: string) => buildResumeThreadApiPath(threadId)],
    ["deleting", "DELETE", (threadId: string) => buildThreadApiPath(threadId)],
  ] as const)(
    "answers %s another user's thread exactly as one that does not exist, and changes nothing",
    async (_, method, pathFor) => {
      const missingThreadId = "33333333-3333-4333-8333-333333333333";
      const before = await controlPlane.getApi(buildThreadApiPath(adaThread.threadId), adaToken);

      const othersThread = await controlPlane.sendApi(
        method,
        pathFor(adaThread.threadId),
        graceToken,
      );
      const missingThread = await controlPlane.sendApi(
        method,
        pathFor(missingThreadId),
        graceToken,
      );
      await controlPlane.whenOperationsSettle();

      expect(await describeAnswer(othersThread, adaThread.threadId)).toEqual(
        await describeAnswer(missingThread, missingThreadId),
      );
      expect(othersThread.status).toBe(404);
      const after = await controlPlane.getApi(buildThreadApiPath(adaThread.threadId), adaToken);
      expect(await after.json()).toEqual(await before.json());
      expect(controlPlane.sandboxProvider.calls.map((call) => call.operation)).toEqual(["create"]);
    },
  );

  it("lets the owner stop, resume and delete their own thread", async () => {
    const stopped = await controlPlane.sendApi(
      "POST",
      buildStopThreadApiPath(adaThread.threadId),
      adaToken,
    );
    await controlPlane.whenOperationsSettle();
    const resumed = await controlPlane.sendApi(
      "POST",
      buildResumeThreadApiPath(adaThread.threadId),
      adaToken,
    );
    await controlPlane.whenOperationsSettle();
    const deleted = await controlPlane.sendApi(
      "DELETE",
      buildThreadApiPath(adaThread.threadId),
      adaToken,
    );
    await controlPlane.whenOperationsSettle();

    expect([stopped.status, resumed.status, deleted.status]).toEqual([202, 202, 202]);
    expect(await listThreadIds(adaToken)).toEqual([]);
  });

  it.each([
    ["opening", (_: TestClient) => undefined],
    ["sending a message to", (client: TestClient) => client.sendUserMessage("Delete everything")],
    ["interrupting", (client: TestClient) => client.interruptAgent()],
  ])(
    "answers %s another user's thread over the WebSocket exactly as a thread that does not exist",
    async (_, send) => {
      const supervisor = await controlPlane.connectSupervisor(adaThread);

      const othersThread = await connectAndSend(adaThread.threadId, graceToken, send);
      const missingThread = await connectAndSend("thread-never-created", graceToken, send);

      expect(othersThread).toEqual({ closeCode: closeCodes.threadNotFound, received: [] });
      expect(missingThread).toEqual(othersThread);
      const adaClient = await controlPlane.connectClient(adaThread.threadId, 0, adaToken);
      expect(adaClient.threadEvents).toEqual([]);
      expect(supervisor.inbox.messages).toEqual([
        { type: "supervisor_welcome", lastRecordedEventNumber: 0 },
        { type: "prepare_workspace", repository: null, agentHasWorkedBefore: false },
      ]);
    },
  );

  it("shows what the control plane records on its own, and messages waiting for an agent, only to the owner", async () => {
    const graceThread = await controlPlane.createThread(graceToken);
    const graceClient = await controlPlane.connectClient(graceThread.threadId, 0, graceToken);
    const adaClient = await controlPlane.connectClient(adaThread.threadId, 0, adaToken);
    const abandoningSupervisor = await controlPlane.connectSupervisor(adaThread);
    abandoningSupervisor.sendAgentEvent(agentRunStarted);
    await abandoningSupervisor.waitUntilRecorded(1);
    await abandoningSupervisor.close();
    adaClient.sendUserMessage("Waiting for the next supervisor");
    await adaClient.waitForSequence(2);

    const replacingSupervisor = await controlPlane.connectSupervisor(adaThread);
    await adaClient.waitForSequence(3);
    await replacingSupervisor.inbox.waitFor(
      "the waiting message",
      (message) => message.type === "deliver_user_message",
    );
    const graceOpeningAdaThread = await connectAndSend(
      adaThread.threadId,
      graceToken,
      () => undefined,
    );

    expect(adaClient.threadEvents.map((recorded) => recorded.event.type)).toEqual([
      "agent_run_started",
      "user_message",
      "agent_failed",
    ]);
    expect(graceOpeningAdaThread).toEqual({ closeCode: closeCodes.threadNotFound, received: [] });
    expect(graceClient.inbox.messages.map((message) => message.type)).toEqual([
      "replay_announcement",
      "supervisor_connection_status",
      "user_message_delivery_status",
    ]);
  });

  it("lets the owner use the thread", async () => {
    const supervisor = await controlPlane.connectSupervisor(adaThread);
    const client = await controlPlane.connectClient(adaThread.threadId, 0, adaToken);

    client.sendUserMessage("Hello");

    await supervisor.inbox.waitFor(
      "the message",
      (message) => message.type === "deliver_user_message",
    );
  });
});

describe("requests without a valid token", () => {
  beforeEach(async () => {
    await start();
  });

  it("are refused by every thread route with 401", async () => {
    const thread = await controlPlane.createThread(await signIn(ada));
    const expired = await signIn(ada, -60);

    const answers = await Promise.all([
      controlPlane.getApi(threadsApiPath, undefined),
      controlPlane.getApi(buildThreadApiPath(thread.threadId), undefined),
      controlPlane.postThread({ ...browserHeaders(""), Authorization: "" }),
      controlPlane.getApi(threadsApiPath, expired),
      controlPlane.getApi(threadsApiPath, "not-a-token"),
      controlPlane.postThread(browserHeaders(expired)),
    ]);

    expect(answers.map((answer) => answer.status)).toEqual([401, 401, 401, 401, 401, 401]);
    expect(
      controlPlane.sandboxProvider.calls.filter((call) => call.operation === "create"),
    ).toHaveLength(1);
  });

  it("are refused over the WebSocket when the first token has expired, with accessTokenExpired", async () => {
    const thread = await controlPlane.createThread(await signIn(ada));
    const client = await controlPlane.openUnauthenticatedClient(thread.threadId);

    client.authenticate(await signIn(ada, -60));

    expect((await client.closed).closeCode).toBe(closeCodes.accessTokenExpired);
    expect(client.inbox.messages).toEqual([]);
  });
});

describe("an open connection's tokens", () => {
  let thread: TestThread;

  beforeEach(async () => {
    await start();
    thread = await controlPlane.createThread(await signIn(ada));
  });

  it("must keep naming the same user: a token for another user closes the connection", async () => {
    const client = await controlPlane.connectClient(thread.threadId, 0, await signIn(ada));

    client.authenticate(await signIn(grace));

    expect((await client.closed).closeCode).toBe(closeCodes.notAuthenticated);
  });

  it("close the connection with accessTokenExpired when the last one expires without a replacement", async () => {
    const client = await controlPlane.connectClient(thread.threadId, 0, await signIn(ada, 2));
    const openedAt = Date.now();

    const { closeCode } = await client.closed;

    expect(closeCode).toBe(closeCodes.accessTokenExpired);
    expect(Date.now() - openedAt).toBeGreaterThan(500);
  });

  it("keep the connection open past the first token's expiry when a fresh one arrives in time", async () => {
    const client = await controlPlane.connectClient(thread.threadId, 0, await signIn(ada, 2));

    client.authenticate(await signIn(ada, 3600));
    await sleep(2_500);
    client.sendUserMessage("Still here");

    await client.inbox.waitFor(
      "the message, recorded to wait for an agent",
      (message) => message.type === "thread_event" && message.event.type === "user_message",
    );
  });

  it("let a client that reconnects after expiry, with a fresh token, resume from its last seen sequence without loss or duplication", async () => {
    const supervisor = await controlPlane.connectSupervisor(thread);
    const firstConnection = await controlPlane.connectClient(
      thread.threadId,
      0,
      await signIn(ada, 2),
    );
    supervisor.sendAgentEvent(toolExecutionStarted("call-1"));
    supervisor.sendAgentEvent(toolExecutionStarted("call-2"));
    await firstConnection.waitForSequence(2);

    expect((await firstConnection.closed).closeCode).toBe(closeCodes.accessTokenExpired);
    supervisor.sendAgentEvent(toolExecutionStarted("call-3"));
    const observer = await controlPlane.connectClient(thread.threadId, 2, await signIn(ada));
    await observer.waitForSequence(3);
    const lastSeenSequence = firstConnection.threadEvents.at(-1)?.sequence ?? 0;
    const secondConnection = await controlPlane.connectClient(
      thread.threadId,
      lastSeenSequence,
      await signIn(ada),
    );
    await secondConnection.waitForSequence(3);

    const sequences = [...firstConnection.threadEvents, ...secondConnection.threadEvents].map(
      (event) => event.sequence,
    );
    expect(sequences).toEqual([1, 2, 3]);
  });
});

describe("an installation that admits listed email addresses", () => {
  beforeEach(async () => {
    controlPlane = await TestControlPlane.start({
      authentication: {
        kind: "test-issuer",
        issuer,
        admission: { kind: "listed-email-addresses", emailAddresses: new Set([ada.email]) },
      },
    });
  });

  it("lets in a user whose confirmed address is listed", async () => {
    expect(await listThreadIds(await signIn({ ...ada, email: "ADA@example.com" }))).toEqual([]);
  });

  it("refuses a signed-in user whose address is not listed, with 403 and userNotAllowed", async () => {
    const graceToken = await signIn(grace);
    const adaThread = await controlPlane.createThread(await signIn(ada));

    const response = await controlPlane.getApi(threadsApiPath, graceToken);
    const client = await controlPlane.connectClient(adaThread.threadId, 0, graceToken);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "not_allowed" } });
    expect((await client.closed).closeCode).toBe(closeCodes.userNotAllowed);
  });

  it("refuses a listed address that Supabase has not confirmed the user owns", async () => {
    const impostor = { userId: "44444444-4444-4444-8444-444444444444", email: ada.email };
    issuer.markEmailUnconfirmed(impostor.userId);

    const response = await controlPlane.getApi(threadsApiPath, await signIn(impostor));

    expect(response.status).toBe(403);
  });

  it("refuses a user whose token names no email address", async () => {
    const response = await controlPlane.getApi(
      threadsApiPath,
      await issuer.mintAccessToken({ userId: ada.userId }),
    );

    expect(response.status).toBe(403);
  });
});

describe("a user's first request", () => {
  it("records the user once, however many requests arrive together", async () => {
    const userStore = new InMemoryUserStore();
    await start({ userStore });
    const token = await signIn(ada);

    const answers = await Promise.all(
      Array.from({ length: 10 }, () => controlPlane.getApi(threadsApiPath, token)),
    );

    expect(answers.map((answer) => answer.status)).toEqual(Array(10).fill(200));
    expect(await userStore.hasUser(ada.userId)).toBe(true);
    expect(await userStore.hasUser(grace.userId)).toBe(false);
  });
});

describeWithTestDatabase("a user's first requests, stored in Postgres", () => {
  let pool: Pool;
  let schemas: TestSchemas;

  beforeAll(() => {
    pool = createTestPool(10);
    schemas = new TestSchemas(pool);
  });

  afterAll(async () => {
    await schemas.dropAll();
    await pool.end();
  });

  it("leave one user row, and threads that belong to it, however many arrive at once", async () => {
    const schema = await schemas.createMigrated();
    await start({
      userStore: new PostgresUserStore(pool, schema),
      threadStore: new PostgresThreadStore(pool, schema),
      threadRepositoryStore: new PostgresThreadRepositoryStore(pool, schema),
    });
    const token = await signIn(ada);

    const answers = await Promise.all(
      Array.from({ length: 10 }, () => controlPlane.postThread(browserHeaders(token))),
    );

    expect(answers.map((answer) => answer.status)).toEqual(Array(10).fill(201));
    const users = await pool.query(`select user_id from "${schema}".users`);
    expect(users.rows).toEqual([{ user_id: ada.userId }]);
    expect(await listThreadIds(token)).toHaveLength(10);
    expect(await listThreadIds(await signIn(grace))).toEqual([]);
  });
});
