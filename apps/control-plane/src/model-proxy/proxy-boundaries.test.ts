import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import { findAgentRequestShape, relayedProviders } from "@barrack/model-catalogue";
import { describe, expect, it } from "vitest";
import { digestConfirmedEmailAddress, OwnerAdmission } from "../authentication/owner-admission.js";
import { inspectWholeBody } from "../test-support/request-bodies.js";
import { InMemoryUserStore } from "../users/in-memory-user-store.js";
import {
  AuthenticationAllowance,
  defaultModelProxyLimits,
  ModelProxyAdmissions,
} from "./model-proxy-limits.js";
import {
  buildDownstreamHeaders,
  buildUpstreamHeaders,
  readPresentedToken,
} from "./proxy-headers.js";
import { findRelayedRoute } from "./relayed-routes.js";
import { requestBodyShapeLimits } from "./request-body.js";
import { maximumReadMemberBytes } from "./request-body-members.js";
import { redactedSecretMarker, SecretRedaction } from "./secret-redaction.js";

/** The proxy's parts that decide what crosses it, each on its own. */

const secret = "fake-key-of-the-owner-0123456789";

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

describe("what the proxy changes in a request's body", () => {
  function relayedJson(
    format: Parameters<typeof inspectWholeBody>[0],
    body: object,
    providerId?: string,
  ): unknown {
    const inspection = inspectWholeBody(format, body, providerId);
    return inspection.kind === "relayable"
      ? JSON.parse(inspection.body.bytes.toString("utf8"))
      : inspection.kind;
  }

  it("asks for a streamed Chat Completions answer's usage when the request does not", () => {
    const streamed = { model: "m", stream: true, messages: [] };

    expect(relayedJson("openai_chat_completions", streamed)).toEqual({
      ...streamed,
      stream_options: { include_usage: true },
    });
    expect(
      relayedJson("openai_chat_completions", {
        ...streamed,
        stream_options: { include_usage: false },
      }),
    ).toBe("refused");
  });

  it("changes nothing else, and nothing in other formats or in an answer not streamed", () => {
    const notStreamed = { model: "m", messages: [], max_tokens: 5 };
    const anthropic = { model: "m", stream: true, max_tokens: 5, messages: [] };

    expect(relayedJson("openai_chat_completions", notStreamed, "together")).toEqual(notStreamed);
    expect(relayedJson("anthropic_messages", anthropic)).toEqual(anthropic);
  });
});

describe("what the proxy reads from a request's body", () => {
  function maximumOutputOf(
    format: Parameters<typeof inspectWholeBody>[0],
    body: object,
    providerId?: string,
  ) {
    const inspection = inspectWholeBody(format, { model: "m", ...body }, providerId);
    return inspection.kind === "relayable" ? inspection.body.maximumOutputTokens : inspection.kind;
  }

  it("reads each format's and each host's own field for the most output", () => {
    const chat = "openai_chat_completions";

    expect(maximumOutputOf(chat, { max_completion_tokens: 50 }, "groq")).toBe(50);
    expect(maximumOutputOf(chat, { max_tokens: 50 }, "together")).toBe(50);
    expect(maximumOutputOf(chat, { max_tokens: 50 }, "groq")).toBe("not_relayed");
    expect(maximumOutputOf("anthropic_messages", { max_tokens: 7 })).toBe(7);
    expect(maximumOutputOf("openai_responses", { max_output_tokens: 9 })).toBe(9);
  });
});

/**
 * The proxy reads a setting the way any JSON decoder would, and relays it
 * only when it is one the agent sends: some providers' decoders match a
 * field's name regardless of case, folding Unicode as they go (Go's
 * `encoding/json` reads `ſtream`, with a long s, as `stream`), so a name
 * the agent never writes is refused rather than read as another.
 */
describe("settings the agent never writes so", () => {
  function outcomeOf(
    body: string,
    format: Parameters<typeof inspectWholeBody>[0] = "openai_chat_completions",
    providerId?: string,
  ) {
    const inspection = inspectWholeBody(format, body, providerId);
    return inspection.kind === "refused" ? inspection.reason : inspection.kind;
  }

  it.each([
    ["another case of a member", '{"model":"m","Model":"the-dearest-model","messages":[]}'],
    ["a Kelvin sign for a k", '{"model":"m","max_completion_toKens":100000}'],
    ["a long s for an s", '{"model":"m","ſtream":true,"messages":[]}'],
    ["a full-width letter", '{"model":"m","ｍax_completion_tokens":100000,"messages":[]}'],
    ["a member in capitals", '{"model":"m","MAX_COMPLETION_TOKENS":100000,"messages":[]}'],
    ["a member written with an escape", '{"mod\\u0065l":"m","messages":[]}'],
  ])("refuses %s at the top level", (_description, body) => {
    expect(outcomeOf(body)).toBe("not_relayed");
  });

  it.each([
    [
      "stream_options",
      '{"model":"m","stream":true,"stream_options":{"include_usage":true,"INCLUDE_USAGE":false}}',
      "openai_chat_completions",
    ],
    ["thinking", '{"model":"m","thinking":{"TYPE":"enabled"},"messages":[]}', "anthropic_messages"],
    [
      "reasoning, with an escape that decodes to another name",
      '{"model":"m","reasoning":{"\\u0045ffort":"none"},"input":[]}',
      "openai_responses",
    ],
    [
      "reasoning, with an effort never sent",
      '{"model":"m","reasoning":{"effort":"ultra"},"input":[]}',
      "openai_responses",
    ],
  ] as const)("refuses a value of %s the agent never sends", (name, body, format) => {
    expect(outcomeOf(body, format)).toMatch(/the value given for `\w+`/);
    expect(name).toBeTruthy();
  });

  it("parses at most 16 KiB of any body, whatever it holds, so checking one costs next to nothing", () => {
    const parsedAtMost = relayedProviders.flatMap(({ providerId, apis }) =>
      apis.map(({ format }) => {
        const members = Object.values(
          findAgentRequestShape(providerId, format, "api_key")?.members ?? {},
        );
        const topLevel = members.filter((rule) => rule !== "scanned").length;
        // And the settings given in conversation items, each different one once.
        return (
          topLevel * maximumReadMemberBytes + requestBodyShapeLimits.maximumDistinctItemSettingBytes
        );
      }),
    );

    expect(Math.max(...parsedAtMost)).toBeLessThanOrEqual(16 * 1024);
    expect(requestBodyShapeLimits.maximumItemSettingBytes).toBe(maximumReadMemberBytes);
    expect(
      outcomeOf(
        `{"model":"m","reasoning":{"effort":"high","summary":"auto","x":"${"a".repeat(2_000)}"},"input":[]}`,
        "openai_responses",
      ),
    ).toMatch(/too long/);
    const updates = Array.from({ length: 1_000 }, (_, index) => ({
      type: "configuration_update",
      reasoning: { effort: "high", [`x${index}`]: 1 },
    }));
    expect(outcomeOf(JSON.stringify({ model: "m", input: updates }), "openai_responses")).toBe(
      "not_relayed",
    );
  });

  it.each([
    ["an effort the agent never gives there", '{"effort":"ultra"}'],
    ["the agent's value written with a space", '{"effort": "high"}'],
    ["the agent's value written with an escape", '{"effort":"hig\\u0068"}'],
    ["the agent's value with a member repeated", '{"effort":"none","effort":"high"}'],
  ])("refuses, in a conversation item, %s", (_description, reasoning) => {
    const body = `{"model":"m","input":[{"type":"configuration_update","reasoning":${reasoning}}]}`;
    const inspection = inspectWholeBody("openai_responses", body);

    expect(inspection.kind === "refused" && inspection.reason).toMatch(
      /the value given for `reasoning` in a `configuration_update` item/,
    );
  });

  it("relays the agent's own settings", () => {
    expect(outcomeOf('{"model":"m","stream":true,"stream_options":{"include_usage":true}}')).toBe(
      "relayable",
    );
    expect(
      outcomeOf(
        '{"model":"m","reasoning":{"effort":"high","summary":"auto"},"include":["reasoning.encrypted_content"],"store":false,"input":[]}',
        "openai_responses",
      ),
    ).toBe("relayable");
    expect(
      outcomeOf(
        '{"model":"m","input":[{"type":"configuration_update","reasoning":{"effort":"high"}}]}',
        "openai_responses",
      ),
    ).toBe("relayable");
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

  it("says the body is JSON in UTF-8, whatever the agent said, or if it said nothing", () => {
    for (const contentType of ["application/json; charset=utf-7", "text/plain", undefined]) {
      expect(
        buildUpstreamHeaders("openai_chat_completions", { "content-type": contentType }, secret)[
          "content-type"
        ],
      ).toBe("application/json");
    }
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

  it("never forgets a thread whose allowance is still part-spent, however many others it remembers", () => {
    const now = 0;
    const admissions = new ModelProxyAdmissions(
      { ...defaultModelProxyLimits, requestBurstPerThread: 2, requestsPerSecondPerThread: 1 },
      () => now,
      3,
    );
    const startAndFinish = (threadId: string) => {
      const admission = admissions.admit(threadId);
      if (admission.kind === "admitted") {
        admission.release();
      }
      return admission.kind;
    };
    startAndFinish("thread-a");
    startAndFinish("thread-a");

    for (let index = 0; index < 10; index += 1) {
      startAndFinish(`thread-${index}`);
    }

    expect(startAndFinish("thread-a")).toBe("thread_busy");
  });
});

describe("the proxy's bound on callers not yet authenticated", () => {
  it("lets only so many token lookups run at once, and so many a second, for the whole instance", () => {
    let now = 0;
    const allowance = new AuthenticationAllowance(
      {
        ...defaultModelProxyLimits,
        authenticationsInFlight: 2,
        authenticationBurst: 3,
        authenticationsPerSecond: 1,
      },
      () => now,
    );

    const first = allowance.enter();
    const second = allowance.enter();
    const third = allowance.enter();
    if (first.kind === "entered") {
      first.leave();
    }
    const fourth = allowance.enter();
    const fifth = allowance.enter();
    now = 1_000;
    if (second.kind === "entered") {
      second.leave();
    }
    const sixth = allowance.enter();

    expect([first.kind, second.kind, third.kind, fourth.kind, fifth.kind, sixth.kind]).toEqual([
      "entered",
      "entered",
      "busy",
      "entered",
      "busy",
      "entered",
    ]);
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
