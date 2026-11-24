import { parseModelReference, type ThreadSummary } from "@barrack/protocol";
import { useState } from "react";
import { describeModel, listProviderChoices } from "../model-access/model-choices";
import { useModelAccess } from "../model-access/use-model-access";
import { settingsAddress } from "../page-address";
import { ModelPicker } from "./model-picker";

type ThreadModelPanelProperties = {
  thread: ThreadSummary;
  isSwitching: boolean;
  switchFailure: string | undefined;
  onSwitch: (model: string) => void;
};

/**
 * The thread's model, a warning when the user has no key for it (the agent
 * cannot answer until they add one), and a way to switch to another: the
 * conversation carries on, on the new model, from the agent's next run.
 */
export function ThreadModelPanel({
  thread,
  isSwitching,
  switchFailure,
  onSwitch,
}: ThreadModelPanelProperties) {
  const { view } = useModelAccess();
  const [chosenModel, setChosenModel] = useState<string | undefined>(undefined);
  const catalogue = view.name === "loaded" ? view.catalogue : undefined;
  const hasKey =
    thread.model === null ||
    view.name !== "loaded" ||
    view.credentials.some(
      (credential) => credential.providerId === parseModelReference(thread.model ?? "").providerId,
    );

  return (
    <section className="thread-model" aria-label="Model">
      <p>
        Model:{" "}
        <strong>
          {thread.model === null ? "none chosen" : describeModel(thread.model, catalogue)}
        </strong>{" "}
        {chosenModel === undefined && (
          <button
            type="button"
            className="quiet-button"
            disabled={view.name !== "loaded"}
            onClick={() => setChosenModel(thread.model ?? "")}
          >
            Change model
          </button>
        )}
      </p>
      {!hasKey && (
        <p className="sandbox-banner sandbox-banner-warning" role="alert">
          You have no key for this model's provider, so the agent cannot answer.{" "}
          <a href={settingsAddress}>Add one in Settings</a>, or switch to another model.
        </p>
      )}
      {switchFailure !== undefined && (
        <p className="error-notice" role="alert">
          {switchFailure}
        </p>
      )}
      {chosenModel !== undefined && view.name === "loaded" && (
        <form
          className="thread-model-form"
          onSubmit={(event) => {
            event.preventDefault();
            onSwitch(chosenModel);
            setChosenModel(undefined);
          }}
        >
          <ModelPicker
            catalogue={view.catalogue}
            choices={listProviderChoices(view.catalogue, view.credentials)}
            model={chosenModel}
            onChange={setChosenModel}
          />
          <p className="quiet-note">
            The agent switches from its next run, keeping the conversation.
          </p>
          <div className="sandbox-actions">
            <button type="submit" className="primary-button" disabled={isSwitching}>
              {isSwitching ? "Switching…" : "Switch model"}
            </button>
            <button
              type="button"
              className="quiet-button"
              onClick={() => setChosenModel(undefined)}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
