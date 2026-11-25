import {
  chatGptUsageSettingsUrl,
  type ModelCatalogue,
  modelReferenceSchema,
  parseModelReference,
} from "@barrack/protocol";
import { useState } from "react";
import {
  describeWhyModelCannotRun,
  listChoosableModels,
  type ProviderChoice,
} from "../model-access/model-choices";
import { settingsAddress } from "../page-address";

type ModelPickerProperties = {
  catalogue: ModelCatalogue;
  choices: ProviderChoice[];
  /** As `provider/model`; may be unfinished while the user types. */
  model: string;
  onChange: (model: string) => void;
};

const otherModelValue = "";

/**
 * Chooses a thread's model: a provider, those the user has a key for first,
 * then one of the models the agent's catalogue lists for it, or any other
 * model identifier, since the catalogue is a snapshot and providers add
 * models all the time. Says when the user has no key for the provider. For
 * OpenAI on the user's ChatGPT plan, lists the plan's models and says the
 * plan is in use, with a link to manage its usage, as OpenAI's guidelines
 * ask (https://developers.openai.com/siwc/ui-ux-guidelines).
 */
export function ModelPicker({ catalogue, choices, model, onChange }: ModelPickerProperties) {
  const current = splitModel(model, choices);
  const provider = choices.find((choice) => choice.providerId === current.providerId);
  const listedModels = listChoosableModels(provider);
  const isListed = listedModels.some((listed) => listed.modelId === current.modelId);
  const [isTypingModel, setIsTypingModel] = useState(!isListed && current.modelId !== "");
  const showsModelField = isTypingModel || listedModels.length === 0;
  const problem = describeWhyModelCannotRun(model, choices);

  const chooseProvider = (providerId: string) => {
    const firstModel = listChoosableModels(
      choices.find((choice) => choice.providerId === providerId),
    )[0];
    setIsTypingModel(firstModel === undefined);
    onChange(`${providerId}/${firstModel?.modelId ?? ""}`);
  };

  return (
    <div className="model-picker">
      <label className="form-field">
        Provider
        <select value={current.providerId} onChange={(event) => chooseProvider(event.target.value)}>
          <ProviderOptions label="With your key" choices={choices.filter((c) => c.hasKey)} />
          <ProviderOptions label="Without a key yet" choices={choices.filter((c) => !c.hasKey)} />
        </select>
      </label>
      {listedModels.length > 0 && (
        <label className="form-field">
          Model
          <select
            value={isTypingModel ? otherModelValue : current.modelId}
            onChange={(event) => {
              const modelId = event.target.value;
              setIsTypingModel(modelId === otherModelValue);
              onChange(`${current.providerId}/${modelId}`);
            }}
          >
            {listedModels.map((listed) => (
              <option key={listed.modelId} value={listed.modelId}>
                {listed.name} ({listed.modelId})
              </option>
            ))}
            <option value={otherModelValue}>Another model…</option>
          </select>
        </label>
      )}
      {showsModelField && (
        <label className="form-field">
          Model identifier
          <input
            type="text"
            placeholder="as the provider names it"
            value={current.modelId}
            onChange={(event) => onChange(`${current.providerId}/${event.target.value.trim()}`)}
          />
        </label>
      )}
      {provider?.planModels === undefined ? (
        <p className="quiet-note">
          Models listed are those {catalogue.agent.name} {catalogue.agent.version} knows; any other
          the provider offers can be entered.
        </p>
      ) : (
        <p className="quiet-note">
          Using ChatGPT plan: models listed are those your plan offers that {catalogue.agent.name}{" "}
          {catalogue.agent.version} can run.{" "}
          <a href={chatGptUsageSettingsUrl} target="_blank" rel="noreferrer">
            Manage usage
          </a>
        </p>
      )}
      {problem !== undefined && (
        <p className="sandbox-banner sandbox-banner-warning">
          {problem} <a href={settingsAddress}>Open Settings</a>
        </p>
      )}
    </div>
  );
}

function ProviderOptions({ label, choices }: { label: string; choices: ProviderChoice[] }) {
  if (choices.length === 0) {
    return null;
  }
  return (
    <optgroup label={label}>
      {choices.map((choice) => (
        <option key={choice.providerId} value={choice.providerId}>
          {choice.name}
        </option>
      ))}
    </optgroup>
  );
}

/** The provider and model of what has been chosen or typed so far. */
function splitModel(
  model: string,
  choices: ProviderChoice[],
): { providerId: string; modelId: string } {
  if (modelReferenceSchema.safeParse(model).success) {
    return parseModelReference(model);
  }
  const separatorIndex = model.indexOf("/");
  if (separatorIndex > 0) {
    return { providerId: model.slice(0, separatorIndex), modelId: model.slice(separatorIndex + 1) };
  }
  return { providerId: choices[0]?.providerId ?? "", modelId: "" };
}
