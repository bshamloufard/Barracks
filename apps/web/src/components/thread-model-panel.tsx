import { parseModelReference, type ThreadSummary } from "@barrack/protocol";
import { useEffect, useState } from "react";
import { useSession } from "../authentication/session-context";
import { describeModel, listProviderChoices } from "../model-access/model-choices";
import { useModelAccess } from "../model-access/use-model-access";
import { settingsAddress } from "../page-address";
import { describeUsageTotal, keyPlacementOf } from "../presentation/describe-model-usage";
import { KeyPlacementNote } from "./model-access-settings";
import { ModelPicker } from "./model-picker";

type ThreadModelPanelProperties = {
  thread: ThreadSummary;
  isSwitching: boolean;
  switchFailure: string | undefined;
  /** Whether the agent is working, so usage is read again once it stops. */
  isAgentWorking: boolean;
  onSwitch: (model: string) => void;
};

/**
 * The thread's model and where its key lives, what the thread has used, a
 * warning when the user has no key for it (the agent cannot answer until
 * they add one), and a way to switch to another: the conversation carries
 * on, on the new model, from the agent's next run.
 */
export function ThreadModelPanel({
  thread,
  isSwitching,
  switchFailure,
  isAgentWorking,
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
        {thread.model !== null && (
          <KeyPlacementNote
            placement={keyPlacementOf(catalogue, parseModelReference(thread.model).providerId)}
          />
        )}{" "}
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
      <ThreadUsage threadId={thread.threadId} isAgentWorking={isAgentWorking} />
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

/** What the thread has used, read again whenever the agent stops working. */
function ThreadUsage({ threadId, isAgentWorking }: { threadId: string; isAgentWorking: boolean }) {
  const { modelAccessApi } = useSession();
  const [description, setDescription] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (isAgentWorking) {
      return;
    }
    let isCurrent = true;
    modelAccessApi.readThreadUsage(threadId).then(
      (usage) => isCurrent && setDescription(describeUsageTotal(usage.byModel)),
      () => isCurrent && setDescription("Usage could not be read."),
    );
    return () => {
      isCurrent = false;
    };
  }, [modelAccessApi, threadId, isAgentWorking]);

  return description === undefined ? null : (
    <p className="quiet-note thread-usage">This thread has used: {description}.</p>
  );
}
