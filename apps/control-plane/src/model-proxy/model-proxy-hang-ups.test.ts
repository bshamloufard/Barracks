import { createServer, type Server, type ServerResponse } from "node:http";
import { connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  developmentAccessToken,
  developmentUserId,
} from "../authentication/development-single-user.js";
import { InMemoryModelUsageStore } from "../model-usage/in-memory-model-usage-store.js";
import type { AnswerUsage } from "../model-usage/model-usage-store.js";
import { ControllableThreadEventLog, Gate } from "../test-support/controllable-thread-event-log.js";
import {
  callModelProxy,
  type ProxyAccess,
  relayedFormatExamples,
  waitForProxyAccess,
} from "../test-support/model-proxy-peers.js";
import { TestControlPlane } from "../test-support/test-control-plane.js";
import { InMemoryModelProxyTokenStore } from "./in-memory-model-proxy-token-store.js";
import { idleModelProxyActivity } from "./model-proxy.js";

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

afterEach(async () => {
  await controlPlane?.close();
  controlPlane = undefined;
  heldAnswers.splice(0);
  provider?.closeAllConnections();
  await new Promise((resolve) => provider?.close(resolve));
  provider = undefined;
});

/** A provider that answers at once, unless the request asks it to hold. */
async function startProvider(): Promise<string> {
  provider = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
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

async function startThread(): Promise<{ access: ProxyAccess; stores: Stores; threadId: string }> {
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
): Promise<{ hangUp: () => Promise<void> }> {
  const port = Number(new URL(requireControlPlane().httpBaseUrl).port);
  const socket = connect(port, "127.0.0.1");
  socket.on("error", () => undefined);
  await new Promise((resolve) => socket.once("connect", resolve));
  const head = [
    `POST ${access.basePath}/v1/messages HTTP/1.1`,
    "Host: 127.0.0.1",
    `x-api-key: ${access.token}`,
    "anthropic-version: 2023-06-01",
    "content-type: application/json",
    `content-length: ${Buffer.byteLength(body)}`,
  ].join("\r\n");
  socket.write(`${head}\r\n\r\n`);
  socket.write(Buffer.from(body).subarray(0, sentBytes));
  return {
    hangUp: async () => {
      socket.destroy();
      // Long enough for the control plane to see the socket close.
      await new Promise((resolve) => setTimeout(resolve, 200));
    },
  };
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
