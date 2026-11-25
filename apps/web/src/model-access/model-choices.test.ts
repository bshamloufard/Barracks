import type { ModelCatalogue } from "@barrack/protocol";
import { describe, expect, it } from "vitest";
import {
  describeModel,
  describeWhyModelCannotRun,
  listChoosableModels,
  listProviderChoices,
  suggestModel,
} from "./model-choices";

const catalogue: ModelCatalogue = {
  agent: { name: "Pi", version: "1.6.0" },
  providers: [
    {
      providerId: "anthropic",
      name: "Anthropic",
      secretLabel: "Anthropic API key",
      settings: [],
      isCommon: true,
      models: [{ modelId: "model-a", name: "Model A", contextWindow: 200_000, reasoning: true }],
      keyPlacement: "kept_on_server",
    },
    {
      providerId: "openai",
      name: "OpenAI",
      secretLabel: "OpenAI API key",
      settings: [],
      isCommon: true,
      models: [{ modelId: "model-o", name: "Model O", contextWindow: 400_000, reasoning: true }],
      keyPlacement: "kept_on_server",
    },
  ],
};

const addedAt = "2026-11-24T09:00:00.000Z";

describe("choosing a model", () => {
  it("offers the providers the user has a key for first, their own unlisted ones included", () => {
    const choices = listProviderChoices(catalogue, [
      { providerId: "openai", addedAt, secretEnding: "abcd" },
      { providerId: "mock", addedAt, secretEnding: "efgh" },
    ]);

    expect(choices.map((choice) => [choice.providerId, choice.hasKey])).toEqual([
      ["mock", true],
      ["openai", true],
      ["anthropic", false],
    ]);
  });

  it("suggests the first listed model of the first provider with a key, and nothing without one", () => {
    const withOpenAi = listProviderChoices(catalogue, [
      { providerId: "openai", addedAt, secretEnding: "abcd" },
    ]);

    expect(suggestModel(withOpenAi)).toBe("openai/model-o");
    expect(suggestModel(listProviderChoices(catalogue, []))).toBeUndefined();
  });

  it("says which key is missing, or that the reference is not provider/model", () => {
    const choices = listProviderChoices(catalogue, [
      { providerId: "openai", addedAt, secretEnding: "abcd" },
    ]);

    expect(describeWhyModelCannotRun("openai/any-model-at-all", choices)).toBeUndefined();
    expect(describeWhyModelCannotRun("anthropic/model-a", choices)).toBe(
      "You have no Anthropic API key. Add one in Settings to use this model.",
    );
    expect(describeWhyModelCannotRun("model-a", choices)).toMatch(/provider\/model/);
  });

  it("names a listed model, and shows an unlisted one as it was entered", () => {
    expect(describeModel("anthropic/model-a", catalogue)).toBe("Model A (anthropic/model-a)");
    expect(describeModel("anthropic/newer-model", catalogue)).toBe("anthropic/newer-model");
  });

  it("offers OpenAI's plan models while the user's OpenAI models run on their connected plan", () => {
    const plan = { isConnected: true, models: [{ modelId: "gpt-6.1-sol", name: "GPT-6.1 Sol" }] };
    const choices = listProviderChoices(catalogue, [], plan);
    const openAi = choices.find((choice) => choice.providerId === "openai");

    expect(openAi).toMatchObject({ hasKey: true, name: "OpenAI (your ChatGPT plan)" });
    expect(listChoosableModels(openAi)).toEqual([{ modelId: "gpt-6.1-sol", name: "GPT-6.1 Sol" }]);
    expect(suggestModel(choices)).toBe("openai/gpt-6.1-sol");
  });

  it("says to connect the plan again, not to add a key, once the plan in use is lost", () => {
    const choices = listProviderChoices(catalogue, [], { isConnected: false, models: [] });

    expect(describeWhyModelCannotRun("openai/gpt-6.1-sol", choices)).toContain(
      "your ChatGPT plan, which is not connected",
    );
  });
});
