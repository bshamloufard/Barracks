import type { ModelCatalogue, ModelCredentialSummary } from "@barrack/protocol";
import { type FormEvent, useState } from "react";
import { useSession } from "../authentication/session-context";
import { useModelAccess } from "../model-access/use-model-access";

const otherProviderValue = "";

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

/**
 * The user's own model keys, one per provider: Barrack runs every thread on
 * its owner's key for the thread's model and never pays for model use
 * itself. A key is shown only by its provider, when it was added and its
 * last four characters; once saved, it never comes back to the page.
 */
export function ModelAccessSettings() {
  const { view, reload, replaceCredentials } = useModelAccess();
  const { modelAccessApi } = useSession();
  const [chosenProviderId, setChosenProviderId] = useState<string | undefined>(undefined);
  // Moves on with every change made, so the form starts empty again and no
  // key typed into it stays on the page once it is saved.
  const [changeCount, setChangeCount] = useState(0);
  const [isBusy, setIsBusy] = useState(false);
  const [actionFailure, setActionFailure] = useState<string | undefined>(undefined);

  if (view.name === "loading") {
    return <p className="quiet-note">Loading…</p>;
  }
  if (view.name === "failed") {
    return (
      <div className="error-notice rejection" role="alert">
        <span>{view.reason}</span>
        <button type="button" className="quiet-button" onClick={reload}>
          Try again
        </button>
      </div>
    );
  }
  const { catalogue, credentials } = view;

  const run = (change: Promise<ModelCredentialSummary[]>) => {
    setIsBusy(true);
    setActionFailure(undefined);
    change.then(
      (updated) => {
        setIsBusy(false);
        setChosenProviderId(undefined);
        setChangeCount((count) => count + 1);
        replaceCredentials(updated);
      },
      (error: unknown) => {
        setIsBusy(false);
        setActionFailure(error instanceof Error ? error.message : String(error));
      },
    );
  };

  const save = (providerId: string, secret: string, settings: Record<string, string>) =>
    run(
      modelAccessApi
        .saveCredential(providerId, secret, settings)
        .then(() => modelAccessApi.listCredentials()),
    );

  return (
    <>
      <p>
        Every thread runs on your own key for its model's provider; Barrack pays for no model use.
        Keys are stored encrypted and never shown again. The agent in a thread's sandbox can read
        the key it is given, and so can anything a repository makes it run: prefer a key with a
        spending limit.
      </p>
      {actionFailure !== undefined && (
        <p className="error-notice" role="alert">
          {actionFailure}
        </p>
      )}
      <KeyList
        catalogue={catalogue}
        credentials={credentials}
        isBusy={isBusy}
        onReplace={setChosenProviderId}
        onRemove={(providerId) => run(modelAccessApi.removeCredential(providerId))}
      />
      <KeyForm
        key={`${chosenProviderId ?? "new"}-${changeCount}`}
        catalogue={catalogue}
        initialProviderId={chosenProviderId}
        isBusy={isBusy}
        onSave={save}
      />
    </>
  );
}

function KeyList({
  catalogue,
  credentials,
  isBusy,
  onReplace,
  onRemove,
}: {
  catalogue: ModelCatalogue;
  credentials: ModelCredentialSummary[];
  isBusy: boolean;
  onReplace: (providerId: string) => void;
  onRemove: (providerId: string) => void;
}) {
  if (credentials.length === 0) {
    return <p className="quiet-note">You have added no keys yet.</p>;
  }
  return (
    <ul className="model-credentials" aria-label="Your keys">
      {credentials.map((credential) => (
        <li key={credential.providerId}>
          <span>
            <strong>{nameOf(catalogue, credential.providerId)}</strong>{" "}
            <code>…{credential.secretEnding}</code>{" "}
            <span className="quiet-note">
              added {dateFormat.format(new Date(credential.addedAt))}
            </span>
          </span>
          <span className="sandbox-actions">
            <button
              type="button"
              disabled={isBusy}
              onClick={() => onReplace(credential.providerId)}
            >
              Replace
            </button>
            <button
              type="button"
              className="danger-button"
              disabled={isBusy}
              onClick={() => onRemove(credential.providerId)}
            >
              Remove
            </button>
          </span>
        </li>
      ))}
    </ul>
  );
}

function KeyForm({
  catalogue,
  initialProviderId,
  isBusy,
  onSave,
}: {
  catalogue: ModelCatalogue;
  initialProviderId: string | undefined;
  isBusy: boolean;
  onSave: (providerId: string, secret: string, settings: Record<string, string>) => void;
}) {
  const isInitiallyListed =
    initialProviderId === undefined ||
    catalogue.providers.some((provider) => provider.providerId === initialProviderId);
  const [listedProviderId, setListedProviderId] = useState(
    isInitiallyListed
      ? (initialProviderId ?? catalogue.providers[0]?.providerId ?? otherProviderValue)
      : otherProviderValue,
  );
  const [otherProviderId, setOtherProviderId] = useState(
    isInitiallyListed ? "" : (initialProviderId ?? ""),
  );
  const [secret, setSecret] = useState("");
  const [settings, setSettings] = useState<Record<string, string>>({});
  const provider = catalogue.providers.find((p) => p.providerId === listedProviderId);
  const providerId = provider?.providerId ?? otherProviderId.trim();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSave(providerId, secret.trim(), settings);
  };

  return (
    <form className="model-credential-form" onSubmit={submit} aria-label="Add a key">
      <h3>{initialProviderId === undefined ? "Add a key" : "Replace a key"}</h3>
      <label className="form-field">
        Provider
        <select
          value={listedProviderId}
          onChange={(event) => {
            setListedProviderId(event.target.value);
            setSettings({});
          }}
        >
          <optgroup label="Common">
            {catalogue.providers
              .filter((p) => p.isCommon)
              .map((p) => (
                <option key={p.providerId} value={p.providerId}>
                  {p.name}
                </option>
              ))}
          </optgroup>
          <optgroup label="More providers">
            {catalogue.providers
              .filter((p) => !p.isCommon)
              .map((p) => (
                <option key={p.providerId} value={p.providerId}>
                  {p.name}
                </option>
              ))}
            <option value={otherProviderValue}>Another provider…</option>
          </optgroup>
        </select>
      </label>
      {provider === undefined && (
        <label className="form-field">
          Provider identifier, as the agent's own configuration names it
          <input
            type="text"
            value={otherProviderId}
            onChange={(event) => setOtherProviderId(event.target.value)}
          />
        </label>
      )}
      <label className="form-field">
        {provider?.secretLabel ?? "API key"}
        <input
          type="password"
          autoComplete="off"
          value={secret}
          onChange={(event) => setSecret(event.target.value)}
        />
      </label>
      {provider?.settings.map((setting) => (
        <label key={setting.name} className="form-field">
          {setting.label}
          <input
            type="text"
            value={settings[setting.name] ?? ""}
            onChange={(event) => setSettings({ ...settings, [setting.name]: event.target.value })}
          />
        </label>
      ))}
      <div className="sandbox-actions">
        <button
          type="submit"
          className="primary-button"
          disabled={isBusy || secret.trim() === "" || providerId === ""}
        >
          {isBusy ? "Saving…" : "Save key"}
        </button>
      </div>
    </form>
  );
}

function nameOf(catalogue: ModelCatalogue, providerId: string): string {
  return (
    catalogue.providers.find((provider) => provider.providerId === providerId)?.name ?? providerId
  );
}
