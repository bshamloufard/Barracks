import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import { describe, expect, it } from "vitest";
import { digestConfirmedEmailAddress, OwnerAdmission } from "../authentication/owner-admission.js";
import { InMemoryUserStore } from "../users/in-memory-user-store.js";
import { defaultModelProxyLimits, ModelProxyAdmissions } from "./model-proxy-limits.js";
import {
  buildDownstreamHeaders,
  buildUpstreamHeaders,
  readPresentedToken,
} from "./proxy-headers.js";
import { findRelayedRoute } from "./relayed-routes.js";
import { redactedSecretMarker, SecretRedaction } from "./secret-redaction.js";

/** The proxy's parts that decide what crosses it, each on its own. */

const secret = "sk-real-key-0123456789";

describe("where a relayed request may go", () => {
  it("goes only to the provider's own address, at the path its format uses", () => {
    const anthropic = findRelayedRoute(
      { providerId: "anthropic", method: "POST", apiPath: "/v1/messages", query: "beta=true" },
      undefined,
    );
    const openRouterChat = findRelayedRoute(
      { providerId: "openrouter", method: "POST", apiPath: "/chat/completions", query: "" },
      undefined,
    );

    expect(anthropic).toMatchObject({
      kind: "found",
      route: { format: "anthropic_messages" },
    });
    expect(anthropic.kind === "found" && anthropic.route.upstreamUrl.href).toBe(
      "https://api.anthropic.com/v1/messages?beta=true",
    );
    expect(openRouterChat.kind === "found" && openRouterChat.route.upstreamUrl.href).toBe(
      "https://openrouter.ai/api/v1/chat/completions",
    );
  });

  it("refuses other paths, queries and methods, and providers whose keys stay in the sandbox", () => {
    const route = (providerId: string, method: string, apiPath: string, query = "") =>
      findRelayedRoute({ providerId, method, apiPath, query }, undefined).kind;

    expect(route("anthropic", "POST", "/v1/complete")).toBe("path_not_allowed");
    expect(route("anthropic", "POST", "/v1/messages", "beta=false")).toBe("path_not_allowed");
    expect(route("openai", "GET", "/responses")).toBe("method_not_allowed");
    expect(route("openai", "POST", "/chat/completions")).toBe("path_not_allowed");
    expect(route("google", "POST", "/v1/models")).toBe("not_relayed");
  });

  it("keeps the provider's path when tests point every provider at a mock", () => {
    const lookup = findRelayedRoute(
      { providerId: "openai", method: "POST", apiPath: "/responses", query: "" },
      "http://127.0.0.1:4010",
    );

    expect(lookup.kind === "found" && lookup.route.upstreamUrl.href).toBe(
      "http://127.0.0.1:4010/v1/responses",
    );
  });
});

describe("the headers that cross the proxy", () => {
  it("takes the agent's token from either header its clients use", () => {
    expect(readPresentedToken({ "x-api-key": "token-a" })).toBe("token-a");
    expect(readPresentedToken({ authorization: "Bearer token-b" })).toBe("token-b");
    expect(readPresentedToken({})).toBeUndefined();
  });

  it("sends the owner's key the way each format expects, and nothing of the sandbox's credential", () => {
    const incoming = {
      "x-api-key": "sandbox-token",
      authorization: "Bearer sandbox-token",
      "content-type": "application/json",
      host: "control-plane",
    };

    expect(buildUpstreamHeaders("anthropic_messages", incoming, secret)).toEqual({
      "content-type": "application/json",
      "accept-encoding": "identity",
      "x-api-key": secret,
    });
    expect(buildUpstreamHeaders("openai_responses", incoming, secret)).toEqual({
      "content-type": "application/json",
      "accept-encoding": "identity",
      authorization: `Bearer ${secret}`,
    });
  });

  it("passes back only what the agent's client reads, and never a value holding the key", () => {
    expect(
      buildDownstreamHeaders(
        {
          "content-type": "text/event-stream",
          "retry-after": "3",
          "anthropic-ratelimit-requests-remaining": "10",
          "set-cookie": ["a=b"],
          server: "provider",
          "request-id": `id-${secret}`,
        },
        secret,
      ),
    ).toEqual({
      "cache-control": "no-store",
      "content-type": "text/event-stream",
      "retry-after": "3",
      "anthropic-ratelimit-requests-remaining": "10",
    });
  });
});

describe("redacting the owner's key from an answer", () => {
  it("replaces it wherever it falls, across chunk boundaries too", async () => {
    const text = `start ${secret} middle ${secret}${secret} end`;
    const chunks = text.match(/.{1,5}/g) ?? [];

    const redacted = (
      await buffer(Readable.from(chunks).pipe(new SecretRedaction(secret)))
    ).toString();

    expect(redacted).toBe(
      `start ${redactedSecretMarker} middle ${redactedSecretMarker}${redactedSecretMarker} end`,
    );
  });
});

describe("the proxy's limits on one thread", () => {
  it("admits a thread's requests only up to its limit at once, and others' regardless", () => {
    const admissions = new ModelProxyAdmissions({
      ...defaultModelProxyLimits,
      concurrentRequestsPerThread: 2,
      concurrentRequestsInTotal: 3,
    });

    const first = admissions.admit("thread-a");
    const second = admissions.admit("thread-a");
    const third = admissions.admit("thread-a");
    const others = admissions.admit("thread-b");
    const overInstance = admissions.admit("thread-c");

    expect([first.kind, second.kind, third.kind, others.kind]).toEqual([
      "admitted",
      "admitted",
      "thread_busy",
      "admitted",
    ]);
    expect(overInstance.kind).toBe("instance_busy");
    if (first.kind === "admitted") {
      first.release();
      first.release();
    }
    expect(admissions.inFlightInTotal).toBe(2);
    expect(admissions.admit("thread-a").kind).toBe("admitted");
  });

  it("lets a thread start a burst, then a few a second", () => {
    let now = 0;
    const admissions = new ModelProxyAdmissions(
      { ...defaultModelProxyLimits, requestBurstPerThread: 3, requestsPerSecondPerThread: 1 },
      () => now,
    );
    const startAndFinish = () => {
      const admission = admissions.admit("thread-a");
      if (admission.kind === "admitted") {
        admission.release();
      }
      return admission.kind;
    };

    expect([startAndFinish(), startAndFinish(), startAndFinish(), startAndFinish()]).toEqual([
      "admitted",
      "admitted",
      "admitted",
      "thread_busy",
    ]);
    now = 1_000;
    expect(startAndFinish()).toBe("admitted");
    expect(startAndFinish()).toBe("thread_busy");
  });
});

describe("whether a thread's owner is still admitted", () => {
  it("is yes for every user when anyone who can sign in is", async () => {
    const admission = new OwnerAdmission(
      { kind: "anyone-who-can-sign-in" },
      new InMemoryUserStore(),
    );

    expect(await admission.isStillAdmitted("someone")).toBe(true);
  });

  it("follows the listed addresses as they are now, by the address last confirmed", async () => {
    const users = new InMemoryUserStore();
    await users.recordUser("ada", digestConfirmedEmailAddress("ada@example.com"));
    await users.recordUser("grace", digestConfirmedEmailAddress("grace@example.com"));
    await users.recordUser("unconfirmed", undefined);
    const admission = new OwnerAdmission(
      { kind: "listed-email-addresses", emailAddresses: new Set(["ada@example.com"]) },
      users,
    );

    expect(await admission.isStillAdmitted("ada")).toBe(true);
    expect(await admission.isStillAdmitted("grace")).toBe(false);
    expect(await admission.isStillAdmitted("unconfirmed")).toBe(false);
    expect(await admission.isStillAdmitted("nobody")).toBe(false);
  });
});
