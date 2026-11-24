import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { catalogueFileUrl, formatCatalogue } from "../src/catalogue-file.js";
import { findCatalogueProvider, findModelLimits, modelCatalogue } from "../src/index.js";
import { formatModelLimits, modelLimitsFileUrl } from "../src/model-limits-file.js";
import {
  readAgentCatalogue,
  readAgentModelLimits,
  readPinnedAgentVersion,
} from "./read-agent-catalogue.js";

/**
 * The catalogue is generated from Pi and committed, so the control plane
 * never has to install or run Pi. These tests keep it honest: they fail as
 * soon as the supervisor pins another Pi, or the installed Pi lists
 * something the committed catalogue does not, until it is generated again.
 */

const supervisorPackageUrl = new URL(
  "../../../apps/sandbox-supervisor/package.json",
  import.meta.url,
);

async function readSupervisorPinnedVersion(): Promise<string | undefined> {
  const supervisorPackage = JSON.parse(await readFile(supervisorPackageUrl, "utf8")) as {
    dependencies: Record<string, string>;
  };
  return supervisorPackage.dependencies["@earendil-works/pi-coding-agent"];
}

describe("the model catalogue", () => {
  it("was generated from the Pi the sandbox supervisor pins", async () => {
    const pinnedVersion = await readSupervisorPinnedVersion();

    expect(await readPinnedAgentVersion()).toBe(pinnedVersion);
    expect(modelCatalogue.agent).toEqual({ name: "Pi", version: pinnedVersion });
  });

  it("is exactly what that Pi lists today; run `pnpm --filter @barrack/model-catalogue generate` if not", {
    timeout: 60_000,
  }, async () => {
    const committed = await readFile(catalogueFileUrl, "utf8");

    expect(committed).toBe(formatCatalogue(await readAgentCatalogue()));
  });

  it("lists the common providers first, each with a key to ask for and models to choose", () => {
    const firstProviderIds = modelCatalogue.providers.slice(0, 3).map((p) => p.providerId);

    expect(firstProviderIds).toEqual(["anthropic", "openai", "google"]);
    expect(findCatalogueProvider("anthropic")).toMatchObject({
      secretLabel: "Anthropic API key",
      settings: [],
      isCommon: true,
    });
    expect(findCatalogueProvider("anthropic")?.models.length).toBeGreaterThan(0);
  });

  it("names the settings a provider needs beside its key, as the agent reads them", () => {
    expect(findCatalogueProvider("cloudflare-workers-ai")?.settings).toEqual([
      { name: "CLOUDFLARE_ACCOUNT_ID", label: "Cloudflare account ID" },
    ]);
  });

  it("leaves out providers that offer no key, such as a subscription sign-in", () => {
    expect(findCatalogueProvider("openai-codex")).toBeUndefined();
  });
});

describe("the relayed providers' model limits", () => {
  it("are exactly what that Pi lists today; run `pnpm --filter @barrack/model-catalogue generate` if not", {
    timeout: 60_000,
  }, async () => {
    const committed = await readFile(modelLimitsFileUrl, "utf8");

    expect(committed).toBe(formatModelLimits(await readAgentModelLimits()));
  });

  it("give each relayed model's most output, and the fallbacks the agent sends for it", () => {
    const relayedModels = (providerId: string) =>
      findCatalogueProvider(providerId)?.models.map((model) => model.modelId) ?? [];

    for (const modelId of relayedModels("anthropic")) {
      expect(findModelLimits("anthropic", modelId)?.maxOutputTokens).toBeGreaterThan(0);
    }
    expect(findModelLimits("anthropic", "not-a-model")).toBeUndefined();
    expect(findModelLimits("google", relayedModels("google")[0] ?? "")).toBeUndefined();
  });
});
