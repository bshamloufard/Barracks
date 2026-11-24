import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { agentRequestShapesFileUrl } from "../src/agent-request-shapes-file.js";
import { findAgentRequestShape, isAllowedValue } from "../src/index.js";
import { relayedProviders } from "../src/relayed-providers.js";
import { readAgentRequestShapes } from "./read-agent-request-shapes.js";

/**
 * The model proxy relays only requests shaped like the pinned Pi's
 * (`agent-request-shapes.json`). These tests keep that list in step with
 * Pi: the first fails when Pi can send something the list does not allow,
 * or the list allows something Pi was not seen to send, so that an upgrade
 * of Pi cannot silently break the agent's own requests and the list cannot
 * quietly grow; the second, that everything the list names is written by
 * Pi's own request builders, so it cannot have come from anywhere else.
 */

const committedShapes = JSON.parse(await readFile(agentRequestShapesFileUrl, "utf8")) as unknown;

/** Pi's request builders for the three relayed formats, in the pi-ai the pinned Pi depends on. */
const piRequestBuilders = [
  "api/anthropic-messages.js",
  "api/openai-responses.js",
  "api/openai-responses-shared.js",
  "api/openai-completions.js",
];

/** pi-ai, the dependency in which the pinned Pi builds its requests, installed beside it. */
async function readPiRequestBuilders(): Promise<string> {
  const piCodingAgentEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const piAiDirectory = path.join(path.dirname(piCodingAgentEntry), "..", "..", "pi-ai", "dist");
  const sources = await Promise.all(
    piRequestBuilders.map((builder) => readFile(path.join(piAiDirectory, builder), "utf8")),
  );
  return sources.join("\n");
}

/**
 * What Pi sends back as the provider gave it rather than writing it: the
 * Responses API's reasoning item is replayed whole, and its `content` holds
 * parts of the provider's own type.
 */
const replayedFromProviderAnswers = new Set(["reasoning_text"]);

describe("the shapes of the agent's requests the proxy relays", () => {
  it("are exactly what that Pi sends today; run `pnpm --filter @barrack/model-catalogue generate` if not", {
    timeout: 180_000,
  }, async () => {
    const { shapes, requestCount } = await readAgentRequestShapes();

    expect(requestCount).toBeGreaterThan(50_000);
    expect(shapes).toEqual(committedShapes);
  });

  it("name only members, types and beta values that Pi's request builders write", async () => {
    const source = await readPiRequestBuilders();
    const named = new Set<string>();
    for (const provider of relayedProviders) {
      for (const { format } of provider.apis) {
        const shape = findAgentRequestShape(provider.providerId, format);
        for (const name of [
          ...Object.keys(shape?.members ?? {}),
          ...(shape?.itemTypes ?? []),
          ...(shape?.partTypes ?? []),
          ...(shape?.imageSourceTypes ?? []),
          ...(shape?.toolTypes ?? []),
          ...(shape?.toolChangeTypes ?? []),
          ...(shape?.cacheControlTypes ?? []),
          ...(shape?.betaHeaderValues ?? []),
        ]) {
          if (name !== null && !replayedFromProviderAnswers.has(name)) {
            named.add(name);
          }
        }
      }
    }

    const notWritten = [...named].filter(
      // As a whole name: a property, a quoted text, or a member assigned.
      (name) =>
        !new RegExp(`(^|[^\\w-])${name.replace(/[-.]/g, "\\$&")}($|[^\\w-])`, "m").test(source),
    );
    expect(named.size).toBeGreaterThan(40);
    expect(notWritten).toEqual([]);
  });

  it("are found for each relayed provider in each format it is relayed in", () => {
    for (const provider of relayedProviders) {
      for (const { format } of provider.apis) {
        expect(findAgentRequestShape(provider.providerId, format)?.members["model"]).toEqual([
          "<text>",
        ]);
      }
    }
    expect(findAgentRequestShape("google", "openai_chat_completions")).toBeUndefined();
  });

  it("match a value only as listed, `<count>` and `<text>` standing for any count and any text", () => {
    const thinking = findAgentRequestShape("anthropic", "anthropic_messages")?.members["thinking"];
    const allowed = Array.isArray(thinking) ? thinking : [];

    expect(
      isAllowedValue(allowed, { type: "enabled", budget_tokens: 1024, display: "summarized" }),
    ).toBe(true);
    expect(
      isAllowedValue(allowed, { type: "enabled", budget_tokens: -1, display: "summarized" }),
    ).toBe(false);
    expect(isAllowedValue(allowed, { type: "enabled", budget_tokens: 1024 })).toBe(false);
    expect(isAllowedValue(allowed, { type: "disabled", Type: "enabled" })).toBe(false);
    expect(isAllowedValue(["<text>"], "any model")).toBe(true);
    expect(isAllowedValue([[{ model: "a" }]], [{ model: "a" }, { model: "b" }])).toBe(false);
  });
});
