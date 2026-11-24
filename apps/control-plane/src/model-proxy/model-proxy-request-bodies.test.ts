import { createServer, request as httpRequest, type Server } from "node:http";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { TestIdentityIssuer } from "@barrack/test-identity-issuer";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ProxyAccess, waitForProxyAccess } from "../test-support/model-proxy-peers.js";
import { inspectWholeBody } from "../test-support/request-bodies.js";
import { TestControlPlane } from "../test-support/test-control-plane.js";
import { idleModelProxyActivity } from "./model-proxy.js";
import type { ModelProxyLimits } from "./model-proxy-limits.js";

/**
 * Request bodies through the proxy: what one thread or one owner may hold
 * of the instance's bytes, how long a body may take, what one body may
 * cost the event loop and the heap, whatever its shape, and how many times
 * over it is held. Two users sign in with tokens from a test identity
 * issuer; a stand-in provider answers every request at once.
 */

const ada = { userId: "11111111-1111-4111-8111-111111111111", email: "ada@example.com" };
const grace = { userId: "22222222-2222-4222-8222-222222222222", email: "grace@example.com" };
const lin = { userId: "33333333-3333-4333-8333-333333333333", email: "lin@example.com" };
const mebibyte = 1024 * 1024;

let issuer: TestIdentityIssuer;
let provider: Server | undefined;
let controlPlane: TestControlPlane | undefined;
const openRequests: Array<{ destroy(): void }> = [];

beforeEach(async () => {
  issuer = await TestIdentityIssuer.start();
});

afterEach(async () => {
  for (const request of openRequests.splice(0)) {
    request.destroy();
  }
  await controlPlane?.close();
  controlPlane = undefined;
  const startedProvider = provider;
  provider = undefined;
  startedProvider?.closeAllConnections();
  await new Promise((resolve) => (startedProvider ? startedProvider.close(resolve) : resolve(0)));
  await issuer.close();
});

/** A control plane relaying to a provider that reads each body and answers at once. */
async function start(limits: Partial<ModelProxyLimits> = {}): Promise<TestControlPlane> {
  provider = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          type: "message",
          model: "a-model",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => provider?.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  if (address === null || typeof address === "string") {
    throw new Error("The stand-in provider is not listening on a TCP port.");
  }
  controlPlane = await TestControlPlane.start({
    authentication: { kind: "test-issuer", issuer },
    modelProxyUpstreamOrigin: `http://127.0.0.1:${address.port}`,
    modelProxyLimits: limits,
  });
  return controlPlane;
}

async function startThread(user: typeof ada): Promise<{ access: ProxyAccess; threadId: string }> {
  const started = requireControlPlane();
  const userToken = await issuer.mintAccessToken(user);
  await started.saveModelCredential("anthropic", `fake-anthropic-key-of-${user.email}`, userToken);
  const thread = await started.createThread(userToken, "anthropic/a-model");
  const access = await waitForProxyAccess(await started.connectSupervisor(thread), "anthropic");
  return { access, threadId: thread.threadId };
}

function requireControlPlane(): TestControlPlane {
  if (controlPlane === undefined) {
    throw new Error("The control plane has not been started.");
  }
  return controlPlane;
}

type Sending = { status: Promise<number> };

/**
 * Sends a body of `totalBytes` with Node's own client: its first
 * `sentBytes` at once and, if `trickle` is set, one more byte every
 * `trickle` milliseconds, as an agent holding its share would.
 */
function send(
  access: ProxyAccess,
  body: Buffer,
  options: { sentBytes?: number; trickleEveryMilliseconds?: number } = {},
): Sending {
  const url = new URL(`${requireControlPlane().httpBaseUrl}${access.basePath}/v1/messages`);
  const request = httpRequest(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": String(body.length),
      "x-api-key": access.token,
      "anthropic-version": "2023-06-01",
    },
  });
  openRequests.push(request);
  const status = new Promise<number>((resolve) => {
    request.on("response", (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.on("error", () => resolve(-1));
  });
  const sentBytes = options.sentBytes ?? body.length;
  request.write(body.subarray(0, sentBytes));
  if (sentBytes === body.length) {
    request.end();
    return { status };
  }
  let position = sentBytes;
  const timer = setInterval(() => {
    if (position < body.length - 1 && !request.destroyed) {
      request.write(body.subarray(position, position + 1));
      position += 1;
    }
  }, options.trickleEveryMilliseconds ?? 1_000);
  void status.finally(() => clearInterval(timer));
  openRequests.push({ destroy: () => clearInterval(timer) });
  return { status };
}

/** An Anthropic request whose text pads it to `totalBytes`. */
function paddedBody(totalBytes: number): Buffer {
  const head = '{"model":"a-model","max_tokens":8,"messages":[{"role":"user","content":"';
  const tail = '"}]}';
  return Buffer.from(head + "a".repeat(totalBytes - head.length - tail.length) + tail);
}

describe("the bytes of request bodies one thread or owner may hold", () => {
  it("lets one thread hold no more than its share, so another user's requests still pass", async () => {
    await start({ maximumRequestBytes: mebibyte, maximumRequestBytesHeldInTotal: 2 * mebibyte });
    const attacker = await startThread(ada);
    const other = await startThread(grace);
    const body = paddedBody(mebibyte - 1024);
    const holding = send(attacker.access, body, {
      sentBytes: body.length - 64,
      trickleEveryMilliseconds: 200,
    });
    await expect
      .poll(() => requireControlPlane().modelProxy.activity.requestBodyBytesHeld)
      .toBeGreaterThan(body.length - 100);
    const secondHolding = send(attacker.access, body, { sentBytes: body.length - 64 });

    expect(await secondHolding.status).toBe(429);
    expect(await send(other.access, paddedBody(1024)).status).toBe(200);
    expect(await send(other.access, paddedBody(512 * 1024)).status).toBe(200);
    void holding;
  });

  it("lets one owner, across threads, hold no more than half the instance's bytes", async () => {
    await start({ maximumRequestBytes: mebibyte, maximumRequestBytesHeldInTotal: 4 * mebibyte });
    const threads = [await startThread(ada), await startThread(ada), await startThread(ada)];
    const other = await startThread(grace);
    const body = paddedBody(mebibyte - 1024);
    const holdings = threads.map((thread) =>
      send(thread.access, body, { sentBytes: body.length - 64, trickleEveryMilliseconds: 200 }),
    );

    expect(await Promise.race(holdings.map((holding) => holding.status))).toBe(429);
    expect(await send(other.access, body).status).toBe(200);
  });

  it("counts what a body grows by when written out again against the same bounds, and refuses it past them", async () => {
    await start({ maximumRequestBytes: mebibyte, maximumRequestBytesHeldInTotal: 2 * mebibyte });
    const body = paddedBody(mebibyte - 64 * 1024);
    for (const holder of [await startThread(ada), await startThread(grace)]) {
      send(holder.access, body, { sentBytes: body.length - 64, trickleEveryMilliseconds: 200 });
    }
    await expect
      .poll(() => requireControlPlane().modelProxy.activity.requestBodyBytesHeld)
      .toBeGreaterThan(2 * body.length - 200);
    const heldBefore = requireControlPlane().modelProxy.activity.requestBodyBytesHeld;
    // A body that just fits what is left of the bound as read, but not once
    // `1e15`, a count the proxy reads, is written out again as 16 digits.
    const head = '{"model":"a-model","max_tokens":1e15,"messages":[{"role":"user","content":"';
    const tail = '"}]}';
    const room = 2 * mebibyte - heldBefore;
    const growing = Buffer.from(head + "a".repeat(room - head.length - tail.length) + tail);
    const { access } = await startThread(lin);

    expect(await send(access, growing).status).toBe(503);
    expect(requireControlPlane().modelProxy.activity.requestBodyBytesHeld).toBeLessThanOrEqual(
      heldBefore + 128,
    );
  });

  it("refuses a body that takes longer than its deadline, and gives back what it held", async () => {
    await start({ requestBodyDeadlineInMilliseconds: 400 });
    const { access } = await startThread(ada);
    const body = paddedBody(10_000);

    const trickled = send(access, body, { sentBytes: 5_000, trickleEveryMilliseconds: 50 });

    expect(await trickled.status).toBe(408);
    await expect
      .poll(() => requireControlPlane().modelProxy.activity)
      .toEqual(idleModelProxyActivity);
  });

  it("stops reading a body as soon as its thread stops", async () => {
    await start();
    const { access, threadId } = await startThread(ada);
    const body = paddedBody(10_000);
    const reading = send(access, body, { sentBytes: 5_000, trickleEveryMilliseconds: 1_000 });
    await expect
      .poll(() => requireControlPlane().modelProxy.activity.requestBodyBytesHeld)
      .toBeGreaterThan(0);

    requireControlPlane().modelProxy.cancelThread(threadId);

    expect(await reading.status).toBe(403);
    await expect
      .poll(() => requireControlPlane().modelProxy.activity)
      .toEqual(idleModelProxyActivity);
  });
});

describe("what one body costs, whatever its shape", () => {
  it("relays the bytes it received, not a copy, when it changes nothing", () => {
    const body = Buffer.from(JSON.stringify({ model: "a-model", max_tokens: 8, messages: [] }));
    const inspection = inspectWholeBody("anthropic_messages", body);

    expect(inspection.kind === "relayable" && inspection.body.bytes).toBe(body);
  });

  /** Bodies of the largest size relayed, each shaped to cost a parser as much as it can. */
  const hostileShapes: Record<string, (room: number) => string> = {
    "empty objects": (room) => `[${"{},".repeat(Math.floor(room / 3) - 1)}{}]`,
    "empty arrays": (room) => `[${"[],".repeat(Math.floor(room / 3) - 1)}[]]`,
    "small keys": (room) => {
      const members: string[] = [];
      let length = 2;
      for (let index = 0; length < room - 20; index += 1) {
        const member = `"${index.toString(36)}":0`;
        members.push(member);
        length += member.length + 1;
      }
      return `{${members.join(",")}}`;
    },
    "nesting millions deep": (room) => "[".repeat(room / 2) + "]".repeat(room / 2),
    "one plain string": (room) => `"${"a".repeat(room - 2)}"`,
    "one string of accented letters": (room) => `"${"é".repeat(Math.floor((room - 2) / 2))}"`,
    escapes: (room) => `"${"\\u00e9".repeat(Math.floor((room - 2) / 6))}"`,
    "numbers that grow when written out": (room) =>
      `[${"9e20,".repeat(Math.floor(room / 5) - 1)}9e20]`,
  };

  // The delay is measured on the clock, so a busy machine can add to it (a
  // full run beside other work once measured 101 ms against the 100 allowed,
  // where a quiet one measures about 56). A body that truly holds the loop
  // does so every time, so the test may be tried three times: noise passes on
  // another try, and a real hold-up fails all three.
  it.each(Object.keys(hostileShapes))(
    "keeps the event loop free and the heap small for a body of %s at the largest size",
    { timeout: 60_000, retry: 2 },
    async (shape) => {
      await start();
      const { access } = await startThread(ada);
      // Where a body is relayed unread: the arguments of a tool call.
      const head =
        '{"model":"a-model","max_tokens":8,"messages":[{"role":"assistant","content":[{"type":"tool_use","id":"t","name":"n","input":';
      const tail = "}]}]}";
      const room = 32 * mebibyte - head.length - tail.length;
      const body = Buffer.from(`${head}${hostileShapes[shape]?.(room) ?? ""}${tail}`);
      const before = process.memoryUsage();
      let peakGrowth = 0;
      const sampling = setInterval(() => {
        const now = process.memoryUsage();
        peakGrowth = Math.max(
          peakGrowth,
          now.heapUsed + now.arrayBuffers - before.heapUsed - before.arrayBuffers,
        );
      }, 5);
      const delay = monitorEventLoopDelay({ resolution: 10 });
      delay.enable();

      const status = await send(access, body).status;

      delay.disable();
      clearInterval(sampling);
      expect(body.length).toBeLessThanOrEqual(32 * mebibyte);
      expect([200, 400]).toContain(status);
      // The longest the event loop was held up, in milliseconds, while the
      // body was sent, read, checked and relayed, here, by one process.
      expect(delay.max / 1e6).toBeLessThan(100);
      // The test's own copy of the body is in `before`; the proxy's hold
      // and the moment it joins its chunks come to about two more.
      expect(peakGrowth).toBeLessThan(3 * body.length);
      await expect
        .poll(() => requireControlPlane().modelProxy.activity)
        .toEqual(idleModelProxyActivity);
    },
  );
});
