import { createServer, type IncomingMessage, type Server, ServerResponse } from "node:http";
import { type AddressInfo, connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  developmentAccessToken,
  developmentUserId,
} from "../authentication/development-single-user.js";
import { InMemoryModelUsageStore } from "../model-usage/in-memory-model-usage-store.js";
import type { AnswerUsage } from "../model-usage/model-usage-store.js";
import { ControllableClock } from "../test-support/controllable-clock.js";
import { ControllableThreadEventLog, Gate } from "../test-support/controllable-thread-event-log.js";
import {
  callModelProxy,
  type ProxyAccess,
  relayedFormatExamples,
  waitForProxyAccess,
} from "../test-support/model-proxy-peers.js";
import { TestControlPlane } from "../test-support/test-control-plane.js";
import { silentLogger } from "../test-support/test-database.js";
import { InMemoryModelProxyTokenStore } from "./in-memory-model-proxy-token-store.js";
import { idleModelProxyActivity } from "./model-proxy.js";
import { defaultModelProxyLimits } from "./model-proxy-limits.js";
import { ProxyExchange } from "./proxy-exchange.js";
import { relayRequest } from "./relay-request.js";

/**
 * An agent may hang up at any moment, an honest one included (Pi aborts a
 * request when the user stops the thread). Whenever it does, the proxy must
 * give back everything the request held: its place among the thread's and
 * the instance's requests, its share of the bytes held, its token lookup,
 * its timers and its request to the provider; and it must count what the
 * provider may bill. Each case holds a request at one point where it
 * waits, hangs up there, and then checks that nothing is left held and
 * that the thread can make its full number of requests at once again.
 *
 * The points where a request waits, in order: its token's lookup; the
 * records about its thread and owner; its body arriving; the model before
 * a switch (only for a model other than the thread's); the provider's
 * first byte; the rest of the answer; and its usage being recorded.
 */

const ownersKey = "fake-anthropic-key-of-the-owner-0001";
const holdBeforeAnswering = "hold before answering";
const holdMidAnswer = "hold mid answer";

/** A pause in the next call to a store, for the test to hang up during. */
class NextCallHold {
  #gate: Gate | undefined;

  hold(): Gate {
    this.#gate = new Gate();
    return this.#gate;
  }

  async pass(): Promise<void> {
    const gate = this.#gate;
    this.#gate = undefined;
    await gate?.pass();
  }
}

class HoldableTokenStore extends InMemoryModelProxyTokenStore {
  readonly lookups = new NextCallHold();

  override async listDigests(threadId: string, providerId: string): Promise<Buffer[]> {
    await this.lookups.pass();
    return super.listDigests(threadId, providerId);
  }
}

class HoldableUsageStore extends InMemoryModelUsageStore {
  readonly capReads = new NextCallHold();
  readonly additions = new NextCallHold();

  override async readOwnCap(ownerUserId: string): Promise<number | undefined> {
    await this.capReads.pass();
    return super.readOwnCap(ownerUserId);
  }

  override async add(usage: AnswerUsage): Promise<void> {
    await this.additions.pass();
    return super.add(usage);
  }
}

class HoldableThreadEventLog extends ControllableThreadEventLog {
  readonly openRunReads = new NextCallHold();

  override async readOpenRunStart(threadId: string): Promise<number | undefined> {
    await this.openRunReads.pass();
    return super.readOpenRunStart(threadId);
  }
}

let provider: Server | undefined;
let controlPlane: TestControlPlane | undefined;
const heldAnswers: ServerResponse[] = [];
/** Every body the provider received whole. */
const receivedBodies: string[] = [];

afterEach(async () => {
  await controlPlane?.close();
  controlPlane = undefined;
  heldAnswers.splice(0);
  receivedBodies.splice(0);
  const stopping = provider;
  provider = undefined;
  stopping?.closeAllConnections();
  await new Promise((resolve) =>
    stopping === undefined ? resolve(undefined) : stopping.close(resolve),
  );
});

/** A provider that answers at once, unless the request asks it to hold. */
async function startProvider(): Promise<string> {
  provider = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      receivedBodies.push(body);
      if (body.includes(holdBeforeAnswering)) {
        heldAnswers.push(response);
        return;
      }
      if (body.includes(holdMidAnswer)) {
        heldAnswers.push(response);
        const start = {
          type: "message_start",
          message: { model: "a-model", usage: { input_tokens: 10, output_tokens: 1 } },
        };
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(`event: message_start\ndata: ${JSON.stringify(start)}\n\n`);
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          type: "message",
          model: "a-model",
          usage: { input_tokens: 3, output_tokens: 2 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => provider?.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  if (address === null || typeof address === "string") {
    throw new Error("The stand-in provider is not listening on a TCP port.");
  }
  return `http://127.0.0.1:${address.port}`;
}

type Stores = {
  tokens: HoldableTokenStore;
  usage: HoldableUsageStore;
  events: HoldableThreadEventLog;
};

async function startThread(
  clock?: ControllableClock,
): Promise<{ access: ProxyAccess; stores: Stores; threadId: string }> {
  const stores: Stores = {
    tokens: new HoldableTokenStore(),
    usage: new HoldableUsageStore(),
    events: new HoldableThreadEventLog(),
  };
  const started = await TestControlPlane.start({
    modelProxyUpstreamOrigin: await startProvider(),
    modelProxyTokenStore: stores.tokens,
    modelUsageStore: stores.usage,
    threadEventLog: stores.events,
    // A cap, so its records are read for every request.
    modelUsageCap: { installationCapTokens: 10_000_000 },
    ...(clock === undefined ? {} : { clock: clock.now }),
  });
  controlPlane = started;
  await started.saveModelCredential("anthropic", ownersKey);
  const thread = await started.createThread(developmentAccessToken, "anthropic/a-model");
  const access = await waitForProxyAccess(await started.connectSupervisor(thread), "anthropic");
  return { access, stores, threadId: thread.threadId };
}

function requireControlPlane(): TestControlPlane {
  if (controlPlane === undefined) {
    throw new Error("The control plane has not been started.");
  }
  return controlPlane;
}

function bodyAsking(text: string, model = "a-model"): string {
  return JSON.stringify({
    model,
    max_tokens: 64,
    stream: true,
    messages: [{ role: "user", content: text }],
  });
}

/**
 * Sends a request on a socket of its own, whole or only its first
 * `sentBytes`, and returns what hangs it up: closing the socket, as the
 * agent's process does when it aborts a request or is stopped.
 */
async function sendHangingUp(
  access: ProxyAccess,
  body: string,
  sentBytes = Buffer.byteLength(body),
): Promise<{ hangUp: () => Promise<void>; send: (body: string) => void; closed: Promise<void> }> {
  const port = Number(new URL(requireControlPlane().httpBaseUrl).port);
  const socket = connect(port, "127.0.0.1");
  socket.on("error", () => undefined);
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  // Read whatever is answered, so the socket notices the control plane closing it.
  socket.resume();
  await new Promise((resolve) => socket.once("connect", resolve));
  socket.write(requestHead(access, body));
  socket.write(Buffer.from(body).subarray(0, sentBytes));
  return {
    hangUp: async () => {
      socket.destroy();
      // Long enough for the control plane to see the socket close.
      await new Promise((resolve) => setTimeout(resolve, 200));
    },
    // Another request on the same connection, before the first is answered: pipelined.
    send: (nextBody) => socket.write(requestHead(access, nextBody) + nextBody),
    closed,
  };
}

function requestHead(access: ProxyAccess, body: string): string {
  const head = [
    `POST ${access.basePath}/v1/messages HTTP/1.1`,
    "Host: 127.0.0.1",
    `x-api-key: ${access.token}`,
    "anthropic-version: 2023-06-01",
    "content-type: application/json",
    `content-length: ${Buffer.byteLength(body)}`,
  ].join("\r\n");
  return `${head}\r\n\r\n`;
}

/** What a thread's agent may do once nothing is held: its full number of requests at once. */
async function expectFullAllowance(access: ProxyAccess): Promise<void> {
  const proxy = requireControlPlane().modelProxy;
  await expect.poll(() => proxy.activity, { timeout: 5_000 }).toEqual(idleModelProxyActivity);
  const statuses = await Promise.all(
    [1, 2, 3, 4].map(async () => {
      const response = await callModelProxy(
        requireControlPlane(),
        access,
        relayedFormatExamples.anthropic,
        "",
        { body: bodyAsking("Hello again") },
      );
      await response.arrayBuffer();
      return response.status;
    }),
  );
  expect(statuses).toEqual([200, 200, 200, 200]);
  await expect.poll(() => proxy.activity).toEqual(idleModelProxyActivity);
}

async function countedFor(threadId: string) {
  return requireControlPlane().modelUsage.listForThread(developmentUserId, threadId);
}

describe("an agent hanging up at each point a request waits", () => {
  it("gives everything back when it hangs up while its token is looked up", async () => {
    const { access, stores } = await startThread();
    const lookup = stores.tokens.lookups.hold();
    const request = await sendHangingUp(access, bodyAsking("Hello"));
    await lookup.reached;
    await request.hangUp();
    lookup.release();

    await expectFullAllowance(access);
  });

  it("gives everything back when it hangs up while its remembered token is looked up again", async () => {
    const clock = new ControllableClock();
    const { access, stores } = await startThread(clock);
    const first = await callModelProxy(
      requireControlPlane(),
      access,
      relayedFormatExamples.anthropic,
      "",
      {
        body: bodyAsking("Hello"),
      },
    );
    await first.arrayBuffer();
    clock.advanceBy(16_000);
    const renewal = stores.tokens.lookups.hold();
    const request = await sendHangingUp(access, bodyAsking("Hello"));
    await renewal.reached;
    const waiting = await sendHangingUp(access, bodyAsking("Hello"));
    await waiting.hangUp();
    await request.hangUp();
    renewal.release();

    await expectFullAllowance(access);
  });

  it("gives everything back, and relays nothing, when it hangs up while the records are checked", async () => {
    const { access, stores, threadId } = await startThread();
    const capRead = stores.usage.capReads.hold();
    const request = await sendHangingUp(access, bodyAsking("Hello"));
    await capRead.reached;
    await request.hangUp();
    capRead.release();

    await expectFullAllowance(access);
    // Only the four requests made afterwards were relayed and counted.
    expect(await countedFor(threadId)).toEqual([
      expect.objectContaining({ source: "measured", answerCount: 4 }),
    ]);
  });

  it("gives everything back when it hangs up while sending its body", async () => {
    const { access } = await startThread();
    const request = await sendHangingUp(access, bodyAsking("Hello"), 20);
    await expect
      .poll(() => requireControlPlane().modelProxy.activity.requestBodyBytesHeld)
      .toBeGreaterThan(0);
    await request.hangUp();

    await expectFullAllowance(access);
  });

  it("gives everything back when it hangs up while the model before a switch is looked up", async () => {
    const { access, stores } = await startThread();
    const openRunRead = stores.events.openRunReads.hold();
    const request = await sendHangingUp(access, bodyAsking("Hello", "another-model"));
    await openRunRead.reached;
    await request.hangUp();
    openRunRead.release();

    await expectFullAllowance(access);
  });

  it("gives everything back, and counts what may be billed, when it hangs up before the provider answers", async () => {
    const { access, threadId } = await startThread();
    const request = await sendHangingUp(access, bodyAsking(holdBeforeAnswering));
    await expect.poll(() => heldAnswers.length).toBe(1);
    await request.hangUp();

    await expectFullAllowance(access);
    expect(await countedFor(threadId)).toEqual(
      expect.arrayContaining([expect.objectContaining({ source: "estimated", answerCount: 1 })]),
    );
  });

  it("gives everything back, and counts what may be billed, when it hangs up mid-answer", async () => {
    const { access, threadId } = await startThread();
    const request = await sendHangingUp(access, bodyAsking(holdMidAnswer));
    await expect.poll(() => heldAnswers.length).toBe(1);
    await request.hangUp();

    await expectFullAllowance(access);
    expect(await countedFor(threadId)).toEqual(
      expect.arrayContaining([expect.objectContaining({ source: "estimated", answerCount: 1 })]),
    );
  });

  it("gives everything back once the usage of an answer it hung up after is recorded", async () => {
    const { access, stores, threadId } = await startThread();
    const addition = stores.usage.additions.hold();
    const request = await sendHangingUp(access, bodyAsking("Hello"));
    await addition.reached;
    await request.hangUp();
    addition.release();

    await expectFullAllowance(access);
    expect(await countedFor(threadId)).toEqual([
      expect.objectContaining({ source: "measured", answerCount: 5 }),
    ]);
  });
});

/**
 * A request sent on a connection before the answer ahead of it has ended
 * (pipelined) is handed over by Node at once, but its response is queued
 * behind the one ahead and, if the connection closes meanwhile, never
 * closes. The pinned agent never pipelines (its HTTP client sends one
 * request at a time on a connection), so the proxy ends such a connection
 * without relaying the request.
 */
describe("a request pipelined behind another", () => {
  const pipelined = "pipelined request";

  it("ends the connection, relaying nothing of it, while the one ahead awaits the provider", async () => {
    const { access, threadId } = await startThread();
    const connection = await sendHangingUp(access, bodyAsking(holdBeforeAnswering));
    await expect.poll(() => heldAnswers.length).toBe(1);
    connection.send(bodyAsking(pipelined));
    await connection.closed;

    await expectFullAllowance(access);
    expect(receivedBodies.filter((body) => body.includes(pipelined))).toEqual([]);
    // The one ahead reached the provider whole, so it is counted.
    expect(await countedFor(threadId)).toEqual(
      expect.arrayContaining([expect.objectContaining({ source: "estimated", answerCount: 1 })]),
    );
  });

  it("ends the connection, relaying nothing of it, while the one ahead is mid-answer", async () => {
    const { access, threadId } = await startThread();
    const connection = await sendHangingUp(access, bodyAsking(holdMidAnswer));
    await expect.poll(() => heldAnswers.length).toBe(1);
    connection.send(bodyAsking(pipelined));
    await connection.closed;

    await expectFullAllowance(access);
    expect(receivedBodies.filter((body) => body.includes(pipelined))).toEqual([]);
    expect(await countedFor(threadId)).toEqual(
      expect.arrayContaining([expect.objectContaining({ source: "estimated", answerCount: 1 })]),
    );
  });

  it("holds nothing once its thread is stopped, the agent never having hung up", async () => {
    const { access, threadId } = await startThread();
    const connection = await sendHangingUp(access, bodyAsking(holdBeforeAnswering));
    await expect.poll(() => heldAnswers.length).toBe(1);
    connection.send(bodyAsking(pipelined));
    await new Promise((resolve) => setTimeout(resolve, 200));
    requireControlPlane().modelProxy.cancelThread(threadId);

    await expect
      .poll(() => requireControlPlane().modelProxy.activity, { timeout: 5_000 })
      .toEqual(idleModelProxyActivity);
    expect(receivedBodies.filter((body) => body.includes(pipelined))).toEqual([]);
  });
});

/**
 * Should a request's response ever be one Node never closes (as a
 * pipelined request's is, if its connection closes while it is queued),
 * the request still ends when its connection closes, and its relay still
 * finishes when it is cancelled or times out.
 */
describe("a request whose response Node never closes", () => {
  const incomingServers: Server[] = [];

  afterEach(async () => {
    for (const server of incomingServers.splice(0)) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  /**
   * A request as Node hands it over, paired with a response that, like one
   * queued behind another, is never given the connection; and what hangs
   * the request's connection up.
   */
  async function receiveWithQueuedResponse(): Promise<{
    request: IncomingMessage;
    response: ServerResponse;
    hangUp: () => void;
  }> {
    const received = Promise.withResolvers<IncomingMessage>();
    const server = createServer((request) => received.resolve(request));
    incomingServers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const socket = connect(port, "127.0.0.1");
    socket.on("error", () => undefined);
    const body = bodyAsking("Hello");
    socket.write(
      `POST /v1/messages HTTP/1.1\r\nHost: 127.0.0.1\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );
    const request = await received.promise;
    return { request, response: new ServerResponse(request), hangUp: () => socket.destroy() };
  }

  function relayTo(
    origin: string,
    incoming: { request: IncomingMessage; response: ServerResponse },
    text: string,
    cancellation: AbortSignal,
    limits = defaultModelProxyLimits,
  ) {
    return relayRequest({
      ...incoming,
      route: { format: "anthropic_messages", upstreamUrl: new URL(`${origin}/v1/messages`) },
      body: Buffer.from(bodyAsking(text)),
      ownerCredential: ownersKey,
      limits,
      holdsBackCredentialRefusal: false,
      cancellation,
    });
  }

  it("ends the request when its connection closes", async () => {
    const { request, response, hangUp } = await receiveWithQueuedResponse();
    const exchange = new ProxyExchange({
      request,
      response,
      target: { threadId: "a-thread", providerId: "anthropic", apiPath: "/v1/messages", query: "" },
      route: { format: "anthropic_messages", upstreamUrl: new URL("http://127.0.0.1/v1/messages") },
      logger: silentLogger,
    });
    hangUp();

    await expect.poll(() => exchange.ending).toBe("agent_went_away");
    exchange.close();
  });

  it("finishes relaying once cancelled before the provider answers, saying the provider received it", async () => {
    const origin = await startProvider();
    const cancellation = new AbortController();
    const relaying = relayTo(
      origin,
      await receiveWithQueuedResponse(),
      holdBeforeAnswering,
      cancellation.signal,
    );
    await expect.poll(() => heldAnswers.length).toBe(1);
    cancellation.abort("thread_ended");

    expect(await relaying).toMatchObject({ wasRequestSent: true, interruption: "cancelled" });
  });

  it("finishes relaying once cancelled mid-answer, with the usage the answer gave", async () => {
    const origin = await startProvider();
    const cancellation = new AbortController();
    const relaying = relayTo(
      origin,
      await receiveWithQueuedResponse(),
      holdMidAnswer,
      cancellation.signal,
    );
    await expect.poll(() => heldAnswers.length).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    cancellation.abort("shutting_down");

    expect(await relaying).toMatchObject({
      wasRequestSent: true,
      interruption: "shutting_down",
      usage: expect.objectContaining({ inputTokens: 10 }),
    });
  });

  it("finishes relaying when it runs out of time", async () => {
    const origin = await startProvider();
    const relaying = relayTo(
      origin,
      await receiveWithQueuedResponse(),
      holdBeforeAnswering,
      new AbortController().signal,
      { ...defaultModelProxyLimits, totalTimeoutInMilliseconds: 200 },
    );

    expect(await relaying).toMatchObject({ wasRequestSent: true, interruption: "timed_out" });
  });
});

describe("the proxy shutting down", () => {
  it("ends its requests in flight at once, counts what they may have cost, and takes no more", async () => {
    const { access, threadId } = await startThread();
    const proxy = requireControlPlane().modelProxy;
    const midAnswer = callModelProxy(
      requireControlPlane(),
      access,
      relayedFormatExamples.anthropic,
      "",
      { body: bodyAsking(holdMidAnswer) },
    ).then(async (response) => {
      await response.arrayBuffer().catch(() => undefined);
      return response.status;
    });
    await expect.poll(() => heldAnswers.length).toBe(1);

    const startedAt = Date.now();
    const left = await proxy.shutDown(10_000);
    const tookMilliseconds = Date.now() - startedAt;
    const afterwards = await callModelProxy(
      requireControlPlane(),
      access,
      relayedFormatExamples.anthropic,
      "",
      { body: bodyAsking("Hello") },
    );

    expect(tookMilliseconds).toBeLessThan(2_000);
    expect(left).toEqual(idleModelProxyActivity);
    expect(await midAnswer).toBe(200);
    expect(await countedFor(threadId)).toEqual([
      expect.objectContaining({ source: "estimated", answerCount: 1 }),
    ]);
    expect(afterwards.status).toBe(503);
  });
});
