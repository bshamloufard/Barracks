import type { GithubConnection, RepositoryAccess } from "@barrack/protocol";
import { type FormEvent, useEffect, useState } from "react";
import type { NewThreadChoices } from "../api/threads-api";
import { useSession } from "../authentication/session-context";
import { listProviderChoices, suggestModel } from "../model-access/model-choices";
import { useModelAccess } from "../model-access/use-model-access";
import { settingsAddress } from "../page-address";
import { ModelPicker } from "./model-picker";

type NewThreadFormProperties = {
  isCreating: boolean;
  onCreate: (choices: NewThreadChoices) => void;
  onCancel: () => void;
};

/**
 * Starts a thread on a model the user chooses, in an empty workspace or from
 * one repository: a public one cloned without credentials, or one of the
 * user's repositories reached through Barrack's GitHub App, which alone can
 * be published from.
 */
export function NewThreadForm({ isCreating, onCreate, onCancel }: NewThreadFormProperties) {
  const { repositoriesApi } = useSession();
  const [connection, setConnection] = useState<GithubConnection | undefined>(undefined);
  const [access, setAccess] = useState<RepositoryAccess>("none");
  const [url, setUrl] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const { view: modelAccess } = useModelAccess();
  const [model, setModel] = useState<string | undefined>(undefined);
  const choices =
    modelAccess.name === "loaded"
      ? listProviderChoices(modelAccess.catalogue, modelAccess.credentials, modelAccess.plan)
      : [];
  const chosenModel = model ?? suggestModel(choices) ?? `${choices[0]?.providerId ?? ""}/`;

  useEffect(() => {
    repositoriesApi.readGithubConnection().then(setConnection, (error: unknown) => {
      console.error(error);
    });
  }, [repositoriesApi]);

  const linkedRepositories = connection?.state === "connected" ? connection.repositories : [];
  const canUseGithubApp = linkedRepositories.length > 0;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmedUrl = url.trim();
    const trimmedBranch = baseBranch.trim();
    onCreate({
      model: chosenModel,
      ...(trimmedUrl === ""
        ? {}
        : {
            repository: {
              url: trimmedUrl,
              access,
              ...(trimmedBranch === "" ? {} : { baseBranch: trimmedBranch }),
            },
          }),
    });
  };

  return (
    <form className="new-thread-form" onSubmit={submit} aria-label="New thread">
      <fieldset>
        <legend>Model</legend>
        {modelAccess.name === "loading" && <p className="quiet-note">Loading the models…</p>}
        {modelAccess.name === "failed" && (
          <p className="error-notice" role="alert">
            {modelAccess.reason}
          </p>
        )}
        {modelAccess.name === "loaded" && (
          <ModelPicker
            catalogue={modelAccess.catalogue}
            choices={choices}
            model={chosenModel}
            onChange={setModel}
          />
        )}
      </fieldset>
      <fieldset>
        <legend>Start from a repository (optional)</legend>
        <label>
          <input
            type="radio"
            name="access"
            checked={access === "none"}
            onChange={() => setAccess("none")}
          />{" "}
          A public repository, cloned without credentials (nothing can be published from it)
        </label>
        <label>
          <input
            type="radio"
            name="access"
            checked={access === "github_app"}
            disabled={!canUseGithubApp}
            onChange={() => {
              setAccess("github_app");
              setUrl(linkedRepositories[0]?.url ?? "");
            }}
          />{" "}
          One of your repositories, through Barrack's GitHub App (can be pushed and opened as a pull
          request)
        </label>
        {!canUseGithubApp && (
          <p className="quiet-note">{describeWhyGithubAppIsUnavailable(connection)}</p>
        )}
        {access === "github_app" ? (
          <label className="form-field">
            Repository
            <select value={url} onChange={(event) => setUrl(event.target.value)}>
              {linkedRepositories.map((repository) => (
                <option key={repository.fullName} value={repository.url}>
                  {repository.fullName}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label className="form-field">
            Repository URL
            <input
              type="url"
              placeholder="https://github.com/owner/name"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
            />
          </label>
        )}
        <label className="form-field">
          Branch to start from
          <input
            type="text"
            placeholder="the repository's default branch"
            value={baseBranch}
            onChange={(event) => setBaseBranch(event.target.value)}
          />
        </label>
      </fieldset>
      <div className="sandbox-actions">
        <button type="submit" className="primary-button" disabled={isCreating}>
          {isCreating ? "Creating…" : "Create thread"}
        </button>
        <button type="button" className="quiet-button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function describeWhyGithubAppIsUnavailable(connection: GithubConnection | undefined) {
  switch (connection?.state) {
    case undefined:
      return "Checking your GitHub connection…";
    case "unavailable":
      return connection.reason;
    case "not_connected":
      return (
        <>
          To use one of your own repositories, <a href={settingsAddress}>connect GitHub</a> first.
        </>
      );
    case "connected":
      return (
        <>
          None of your repositories has Barrack's App installed yet; see{" "}
          <a href={settingsAddress}>Settings</a>.
        </>
      );
  }
}
