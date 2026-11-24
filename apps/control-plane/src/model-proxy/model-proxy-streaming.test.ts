import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  developmentAccessToken,
  developmentUserId,
} from "../authentication/development-single-user.js";
import {
  callModelProxy,
  type ProxyAccess,
  relayedFormatExamples,
  waitForProxyAccess,
} from "../test-support/model-proxy-peers.js";
import { TestControlPlane } from "../test-support/test-control-plane.js";
import type { ModelProxyLimits } from "./model-proxy-limits.js";
import { redactedSecretMarker } from "./secret-redaction.js";

/**
 * The model proxy as a streaming path between an agent and a provider that
 * each misbehave on purpose: a stand-in provider whose every answer the
 * test writes, so it can stream faster than the agent reads, wait for the
 * agent's upload, echo the key it was sent, or redirect elsewhere.
 */

const ownersKey = "fake-anthropic-key-of-the-owner-0001";

type UpstreamHandler = (request: IncomingMessage, response: ServerResponse) => void;

let upstream: Server | undefined;
let controlPlane: TestControlPlane | undefined;

afterEach(async () => {
  await controlPlane?.close();
  upstream?.closeAllConnections();
  await new Promise((resolve) => upstream?.close(resolve));
  upstream = undefined;
});

async function startUpstream(handler: UpstreamHandler): Promise<string> {
  upstream = createServer(handler);
  await new Promise<void>((resolve) => upstream?.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (address === null || typeof address === "string") {
    throw new Error("The stand-in provider is not listening on a TCP port.");
  }
  return `http://127.0.0.1:${address.port}`;
}

/** A control plane relaying to the stand-in, and a thread on Anthropic with its token. */
async function startThreadRelayingTo(
  upstreamOrigin: string,
  modelProxyLimits: Partial<ModelProxyLimits> = {},
): Promise<ProxyAccess> {
  const started = await TestControlPlane.start({
    modelProxyUpstreamOrigin: upstreamOrigin,
    modelProxyLimits,
  });
  controlPlane = started;
  await started.saveModelCredential("anthropic", ownersKey);
  const thread = await started.createThread(developmentAccessToken, "anthropic/a-model");
  const supervisor = await started.connectSupervisor(thread);
  return waitForProxyAccess(supervisor, "anthropic");
}

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** The thread a proxy address is for: `/threads/{threadId}/model-proxy/{providerId}`. */
function threadIdOf(access: ProxyAccess): string {
  return access.basePath.split("/")[2] ?? "";
}

describe("the model proxy as a streaming path", () => {
  it("reads the provider no faster than the agent reads the answer", async () => {
    const chunk = `data: ${JSON.stringify({ type: "ping", padding: "p".repeat(64 * 1024) })}\n\n`;
    const chunkCount = 800;
    let writtenChunks = 0;
    const upstreamOrigin = await startUpstream((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      const writeMore = () => {
        while (writtenChunks < chunkCount) {
          writtenChunks += 1;
          if (!response.write(chunk)) {
            response.once("drain", writeMore);
            return;
          }
        }
        response.end();
      };
      writeMore();
    });
    const access = await startThreadRelayingTo(upstreamOrigin);

    const response = await callModelProxy(
      requireControlPlane(),
      access,
      relayedFormatExamples.anthropic,
      "Say a lot",
    );
    await pause(1_000);
    const writtenWhileNotReading = writtenChunks;
    const answer = await response.text();

    // About 50 MiB were on offer; while the agent read nothing, the
    // provider could write only what the sockets' and streams' buffers hold.
    expect(writtenWhileNotReading * chunk.length).toBeLessThan(16 * 1024 * 1024);
    expect(answer.length).toBe(chunk.length * chunkCount);
  });

  it("reads the agent's upload whole, then sends the provider exactly what it checked", async () => {
    let receivedBody = "";
    let firstBytesArrivedAt: number | undefined;
    const upstreamOrigin = await startUpstream((request, response) => {
      request.on("data", (chunk: Buffer) => {
        firstBytesArrivedAt ??= Date.now();
        receivedBody += chunk.toString("utf8");
      });
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ type: "message", model: "m", usage: {} }));
      });
    });
    const access = await startThreadRelayingTo(upstreamOrigin);
    let lastBytesSentAt = 0;
    const encoder = new TextEncoder();
    const slowUpload = new ReadableStream({
      async start(controller) {
        controller.enqueue(
          encoder.encode('{"model":"a-mod\\u0065l", "thinking": {"type" : "disabled"},'),
        );
        await pause(500);
        lastBytesSentAt = Date.now();
        controller.enqueue(encoder.encode('"max_tokens":5,  "messages":[ ]}'));
        controller.close();
      },
    });

    const response = await callModelProxy(
      requireControlPlane(),
      access,
      relayedFormatExamples.anthropic,
      "",
      { body: slowUpload },
    );
    await response.text();

    expect(response.status).toBe(200);
    expect(firstBytesArrivedAt ?? 0).toBeGreaterThanOrEqual(lastBytesSentAt);
    // What the proxy read is written out as it parsed it; the rest is as sent.
    expect(receivedBody).toBe(
      '{"model":"a-model", "thinking": {"type":"disabled"},"max_tokens":5,  "messages":[ ]}',
    );
  });

  it.each([
    ["is not JSON", "not json"],
    ["is not an object", "[1]"],
    ["names no model", '{"max_tokens":5,"messages":[]}'],
    ["names its model twice", '{"model":"another-model","model":"a-model","max_tokens":5}'],
    [
      "names its model again in another case",
      '{"model":"a-model","Model":"another-model","max_tokens":5}',
    ],
    ["is not UTF-8", Buffer.from([...Buffer.from('{"model":"a-model","x":"'), 0xff, 0x22, 0x7d])],
  ])("refuses a body that %s, sending the provider nothing", async (_description, body) => {
    let upstreamRequests = 0;
    const upstreamOrigin = await startUpstream((_request, response) => {
      upstreamRequests += 1;
      response.end();
    });
    const access = await startThreadRelayingTo(upstreamOrigin);

    const response = await callModelProxy(
      requireControlPlane(),
      access,
      relayedFormatExamples.anthropic,
      "",
      { body },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { type: "invalid_request_error" } });
    expect(upstreamRequests).toBe(0);
  });

  it("refuses as busy a body that would take the instance past the request bytes it holds at once", async () => {
    const upstreamOrigin = await startUpstream((_request, response) => response.end());
    const access = await startThreadRelayingTo(upstreamOrigin, {
      maximumRequestBytesHeldInTotal: 1_000,
    });

    const response = await callModelProxy(
      requireControlPlane(),
      access,
      relayedFormatExamples.anthropic,
      "x".repeat(2_000),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
  });

  it("counts a request the agent abandons before the provider answers, at the most output it allowed", async () => {
    let receivedBytes = 0;
    const upstreamOrigin = await startUpstream((request, response) => {
      request.on("data", (chunk: Buffer) => {
        receivedBytes += chunk.length;
      });
      // A non-streamed answer: the headers come only once it is all generated.
      request.on("end", () => {
        setTimeout(() => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ type: "message", model: "a-model", usage: {} }));
        }, 1_500);
      });
    });
    const access = await startThreadRelayingTo(upstreamOrigin);
    const threadId = threadIdOf(access);
    const conversation = "x".repeat(600_000);
    const hangUp = new AbortController();
    setTimeout(() => hangUp.abort(), 700);

    await callModelProxy(requireControlPlane(), access, relayedFormatExamples.anthropic, "", {
      body: JSON.stringify({
        model: "a-model",
        max_tokens: 32_000,
        messages: [{ role: "user", content: conversation }],
      }),
      signal: hangUp.signal,
    }).catch(() => undefined);

    await expect
      .poll(() => requireControlPlane().modelUsage.listForThread(developmentUserId, threadId))
      .toEqual([
        expect.objectContaining({
          modelId: "a-model",
          source: "estimated",
          outputTokens: 32_000,
          inputTokens: expect.any(Number),
        }),
      ]);
    const [estimate] = await requireControlPlane().modelUsage.listForThread(
      developmentUserId,
      threadId,
    );
    expect(receivedBytes).toBeGreaterThan(600_000);
    expect(estimate?.inputTokens).toBeGreaterThan(150_000);
  });

  it("never returns the owner's key, in a header or the body, whatever the provider echoes", async () => {
    const upstreamOrigin = await startUpstream((request, response) => {
      const echoed = String(request.headers["x-api-key"]);
      response.writeHead(401, {
        "content-type": "application/json",
        "x-request-id": `req-${echoed}`,
        "set-cookie": "tracking=1",
      });
      // The key split across two writes, as a stream may split it.
      const body = JSON.stringify({
        type: "error",
        error: { type: "authentication_error", message: `invalid x-api-key ${echoed}` },
      });
      const middle = body.indexOf(echoed) + 10;
      response.write(body.slice(0, middle));
      setTimeout(() => response.end(body.slice(middle)), 50);
    });
    const access = await startThreadRelayingTo(upstreamOrigin);

    const response = await callModelProxy(
      requireControlPlane(),
      access,
      relayedFormatExamples.anthropic,
      "Say hello",
    );
    const body = await response.text();

    expect(response.status).toBe(401);
    expect(body).not.toContain(ownersKey);
    expect(body).toContain(redactedSecretMarker);
    expect(body).toContain("authentication_error");
    expect(response.headers.get("x-request-id")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("answers, in development mode, only requests addressed to loopback, as the rest of the server does", async () => {
    const upstreamOrigin = await startUpstream((_request, response) => response.end());
    const access = await startThreadRelayingTo(upstreamOrigin);
    const port = new URL(requireControlPlane().httpBaseUrl).port;

    const statusFor = (host: string) =>
      new Promise<number | undefined>((resolve, reject) => {
        const request = httpRequest(
          {
            host: "127.0.0.1",
            port,
            method: "POST",
            path: `${access.basePath}/v1/messages`,
            headers: { host, "x-api-key": access.token, "content-type": "application/json" },
          },
          (response) => {
            response.resume();
            resolve(response.statusCode);
          },
        );
        request.on("error", reject);
        request.end("{}");
      });

    expect(await statusFor("rebound.example:8787")).toBe(403);
    expect(await statusFor(`127.0.0.1:${port}`)).not.toBe(403);
  });

  it("follows no redirect, passing none on to the agent", async () => {
    let redirectedTo = 0;
    const elsewhere = createServer((_request, response) => {
      redirectedTo += 1;
      response.end();
    });
    await new Promise<void>((resolve) => elsewhere.listen(0, "127.0.0.1", resolve));
    const elsewhereAddress = elsewhere.address();
    const elsewherePort =
      elsewhereAddress !== null && typeof elsewhereAddress !== "string" ? elsewhereAddress.port : 0;
    const upstreamOrigin = await startUpstream((_request, response) => {
      response.writeHead(307, { location: `http://127.0.0.1:${elsewherePort}/steal` });
      response.end();
    });
    const access = await startThreadRelayingTo(upstreamOrigin);

    const response = await callModelProxy(
      requireControlPlane(),
      access,
      relayedFormatExamples.anthropic,
      "Say hello",
    );

    expect(response.status).toBe(502);
    expect(response.headers.get("location")).toBeNull();
    expect(redirectedTo).toBe(0);
    await new Promise((resolve) => elsewhere.close(resolve));
  });
});

function requireControlPlane(): TestControlPlane {
  if (controlPlane === undefined) {
    throw new Error("No control plane was started.");
  }
  return controlPlane;
}
