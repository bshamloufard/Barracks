import type { UserModelUsageResponse } from "@barrack/protocol";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { useSession } from "../authentication/session-context";
import {
  describeUsageSource,
  describeUsageTotal,
  formatTokens,
} from "../presentation/describe-model-usage";

type UsageView =
  | { name: "loading" }
  | { name: "failed"; reason: string }
  | { name: "loaded"; usage: UserModelUsageResponse };

/**
 * What the user's threads have used recently, by model, and the cap on it:
 * the installation's, and the lower one they may set themselves. Barrack
 * counts tokens and prices nothing; each user pays their provider.
 */
export function ModelUsageSettings() {
  const { modelAccessApi } = useSession();
  const [view, setView] = useState<UsageView>({ name: "loading" });

  const load = useCallback(() => {
    modelAccessApi.readUsage().then(
      (usage) => setView({ name: "loaded", usage }),
      (error: unknown) => setView({ name: "failed", reason: describeError(error) }),
    );
  }, [modelAccessApi]);

  useEffect(load, [load]);

  if (view.name === "loading") {
    return <p className="quiet-note">Loading…</p>;
  }
  if (view.name === "failed") {
    return (
      <div className="error-notice rejection" role="alert">
        <span>{view.reason}</span>
        <button type="button" className="quiet-button" onClick={load}>
          Try again
        </button>
      </div>
    );
  }
  const { usage } = view;
  return (
    <>
      <CapSummary
        usage={usage}
        onChanged={(updated) => setView({ name: "loaded", usage: updated })}
      />
      <h3>The last {usage.recentDays} days</h3>
      <p>{describeUsageTotal(usage.byModel)}.</p>
      {usage.byModel.length > 0 && <UsageTable usage={usage} />}
      <p className="quiet-note">
        Barrack counts tokens and prices nothing: your provider bills you at its own rates. For
        providers whose keys stay on the server, Barrack measures usage from the provider's own
        answers. For the others, the numbers are what the agent in the sandbox reports, which
        anything running there could change.
      </p>
    </>
  );
}

function UsageTable({ usage }: { usage: UserModelUsageResponse }) {
  return (
    <table className="usage-table" aria-label="Usage by model">
      <thead>
        <tr>
          <th scope="col">Model</th>
          <th scope="col">Counted</th>
          <th scope="col">Input</th>
          <th scope="col">Output</th>
          <th scope="col">Cache read / written</th>
          <th scope="col">Answers</th>
        </tr>
      </thead>
      <tbody>
        {usage.byModel.map((total) => (
          <tr key={`${total.providerId}/${total.modelId}/${total.source}`}>
            <td>
              <code>
                {total.providerId}/{total.modelId}
              </code>
            </td>
            <td>{describeUsageSource(total.source)}</td>
            <td>{total.inputTokens.toLocaleString("en")}</td>
            <td>{total.outputTokens.toLocaleString("en")}</td>
            <td>
              {total.cacheReadTokens.toLocaleString("en")} /{" "}
              {total.cacheWriteTokens.toLocaleString("en")}
            </td>
            <td>{total.answerCount.toLocaleString("en")}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function CapSummary({
  usage,
  onChanged,
}: {
  usage: UserModelUsageResponse;
  onChanged: (usage: UserModelUsageResponse) => void;
}) {
  const { modelAccessApi } = useSession();
  const { cap } = usage;
  const [ownCapText, setOwnCapText] = useState(cap.ownCapTokens?.toString() ?? "");
  const [isBusy, setIsBusy] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const effectiveCap = [cap.installationCapTokens, cap.ownCapTokens]
    .filter((tokens) => tokens !== null)
    .reduce<number | undefined>(
      (lowest, tokens) => (lowest === undefined ? tokens : Math.min(lowest, tokens)),
      undefined,
    );

  const change = (tokens: number | null) => {
    setIsBusy(true);
    setFailure(undefined);
    modelAccessApi.changeOwnCap(tokens).then(
      (updated) => {
        setIsBusy(false);
        setOwnCapText(updated.cap.ownCapTokens?.toString() ?? "");
        onChanged(updated);
      },
      (error: unknown) => {
        setIsBusy(false);
        setFailure(describeError(error));
      },
    );
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const tokens = Number(ownCapText.replaceAll(/[\s,_]/g, ""));
    if (!Number.isSafeInteger(tokens) || tokens <= 0) {
      setFailure("Enter your cap as a whole number of tokens, such as 2000000.");
      return;
    }
    change(tokens);
  };

  return (
    <>
      <p>
        In the last {cap.windowHours} hours your threads have used{" "}
        <strong>{formatTokens(cap.countedTokensInWindow)}</strong> counted by Barrack
        {effectiveCap === undefined ? (
          ", with no cap."
        ) : (
          <>
            {" "}
            of a cap of <strong>{formatTokens(effectiveCap)}</strong>.
          </>
        )}{" "}
        {cap.installationCapTokens === null
          ? "This installation sets no cap of its own."
          : `This installation's cap is ${formatTokens(cap.installationCapTokens)}.`}
      </p>
      <p className="quiet-note">
        Once a cap is reached, requests to providers whose keys stay on the server are refused and
        running threads end their run, until older usage leaves the window. A cap cannot be enforced
        for providers whose keys are placed in the sandbox: their usage is only reported, and does
        not count towards it.
      </p>
      <p className="quiet-note">
        The cap counts tokens only. It is a strong limit on tokens used through Barrack, not a limit
        on your bill: it does not count what a provider charges per call for its own tools (web
        search, code execution and the like), requests already under way may finish past it, and
        some tokens are estimated. Set a spending limit with your provider as well.
      </p>
      {failure !== undefined && (
        <p className="error-notice" role="alert">
          {failure}
        </p>
      )}
      <form className="usage-cap-form" onSubmit={submit} aria-label="Your own cap">
        <label className="form-field">
          Your own cap, in tokens per {cap.windowHours} hours
          <input
            type="text"
            inputMode="numeric"
            value={ownCapText}
            placeholder="No cap of your own"
            onChange={(event) => setOwnCapText(event.target.value)}
          />
        </label>
        <div className="sandbox-actions">
          <button
            type="submit"
            className="primary-button"
            disabled={isBusy || ownCapText.trim() === ""}
          >
            {isBusy ? "Saving…" : "Set my cap"}
          </button>
          {cap.ownCapTokens !== null && (
            <button type="button" disabled={isBusy} onClick={() => change(null)}>
              Remove my cap
            </button>
          )}
        </div>
      </form>
    </>
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
