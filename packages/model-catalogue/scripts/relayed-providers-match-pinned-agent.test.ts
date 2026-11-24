import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findCatalogueProvider } from "../src/index.js";
import { type ProviderApiFormat, relayedProviders } from "../src/relayed-providers.js";

/**
 * The control plane relays a provider's traffic only to the addresses in
 * `relayed-providers.ts`, and only in the wire formats listed there. If the
 * pinned Pi moved one of those providers' models to another address or
 * another API, the proxy would refuse its requests; this test fails first.
 */

/** Pi's names for the APIs the proxy speaks. */
const formatOfPiApi: Readonly<Record<string, ProviderApiFormat>> = {
  "anthropic-messages": "anthropic_messages",
  "openai-responses": "openai_responses",
  "openai-completions": "openai_chat_completions",
};

type PiModel = { api: string; baseUrl: string };

let runtime: ModelRuntime;
let scratchDirectory: string;

beforeAll(async () => {
  scratchDirectory = await mkdtemp(path.join(tmpdir(), "barrack-relayed-providers-"));
  runtime = await ModelRuntime.create({
    authPath: path.join(scratchDirectory, "auth.json"),
    modelsPath: null,
    modelsStorePath: path.join(scratchDirectory, "models-store.json"),
    refreshOnCreate: false,
  });
});

afterAll(async () => {
  await rm(scratchDirectory, { recursive: true, force: true });
});

describe("the providers whose keys stay on the server", () => {
  it.each(relayedProviders.map((provider) => [provider.providerId, provider] as const))(
    "%s: every model the pinned agent offers speaks a listed API at its listed address",
    (providerId, provider) => {
      const models = runtime.getModels(providerId) as unknown as PiModel[];

      expect(models.length).toBeGreaterThan(0);
      const used = new Set(
        models.map((model) =>
          JSON.stringify({
            format: formatOfPiApi[model.api] ?? model.api,
            upstreamBaseUrl: model.baseUrl.replace(/\/+$/, ""),
          }),
        ),
      );
      const listed = new Set(provider.apis.map((api) => JSON.stringify(api)));
      expect([...used].filter((api) => !listed.has(api))).toEqual([]);
    },
  );

  it("are each in the catalogue, marked as keeping their keys on the server", () => {
    for (const { providerId } of relayedProviders) {
      expect(findCatalogueProvider(providerId)?.keyPlacement).toBe("kept_on_server");
    }
    expect(findCatalogueProvider("google")?.keyPlacement).toBe("placed_in_sandbox");
  });

  it("never list two APIs of one provider at the same path", () => {
    for (const provider of relayedProviders) {
      const formats = provider.apis.map((api) => api.format);
      expect(new Set(formats).size).toBe(formats.length);
    }
  });
});
