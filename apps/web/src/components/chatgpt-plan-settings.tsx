import {
  type ChatGptPlanStatus,
  chatGptUsageSettingsUrl,
  type ProviderAccess,
} from "@barrack/protocol";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { ApiRefusal } from "../api/read-api-answer";
import { useSession } from "../authentication/session-context";
import {
  continueWithChatGptLabel,
  describeChatGptPlan,
  planCardText,
  planCardTitle,
  planInUseNotice,
  signInSteps,
} from "../presentation/describe-chatgpt-plan";

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

type PlanView =
  | { name: "loading" }
  | { name: "failed"; reason: string }
  | { name: "loaded"; status: ChatGptPlanStatus };

/** A sign-in begun: OpenAI's page, opened in another tab, and when the pasted address stops being accepted. */
type SignInUnderWay = { authorizationUrl: string; expiresAt: string };

/**
 * The user's ChatGPT plan, through OpenAI's "Sign in with ChatGPT"
 * programme: connecting it by the address the browser ends on, choosing
 * whether OpenAI models run on it or on the API key, and disconnecting.
 * Where the installation does not offer it, says why.
 */
export function ChatGptPlanSettings() {
  const { chatGptPlanApi } = useSession();
  const [view, setView] = useState<PlanView>({ name: "loading" });
  const [signIn, setSignIn] = useState<SignInUnderWay | undefined>(undefined);
  const [isBusy, setIsBusy] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [isPlanInUseNoticeShown, setIsPlanInUseNoticeShown] = useState(false);

  const load = useCallback(() => {
    chatGptPlanApi.readStatus().then(
      (status) => setView({ name: "loaded", status }),
      (error: unknown) => setView({ name: "failed", reason: describeError(error) }),
    );
  }, [chatGptPlanApi]);

  useEffect(load, [load]);

  const run = <Answer,>(change: Promise<Answer>, onDone: (answer: Answer) => void) => {
    setIsBusy(true);
    setFailure(undefined);
    setNotice(undefined);
    change.then(
      (answer) => {
        setIsBusy(false);
        onDone(answer);
      },
      (error: unknown) => {
        setIsBusy(false);
        // A refused sign-in's own words say exactly what to do.
        setFailure(error instanceof ApiRefusal ? error.explanation : describeError(error));
      },
    );
  };

  if (view.name === "loading") {
    return <p className="quiet-note">Loading…</p>;
  }
  if (view.name === "failed") {
    return (
      <p className="error-notice" role="alert">
        {view.reason}
      </p>
    );
  }
  const description = describeChatGptPlan(view.status, (date) => dateFormat.format(new Date(date)));

  const begin = () =>
    run(chatGptPlanApi.startSignIn(), (started) => {
      setSignIn(started);
      window.open(started.authorizationUrl, "_blank", "noopener,noreferrer");
    });

  const finish = (finalAddress: string) =>
    run(chatGptPlanApi.finishSignIn(finalAddress), (status) => {
      setSignIn(undefined);
      setView({ name: "loaded", status });
      setIsPlanInUseNoticeShown(true);
    });

  const chooseAccess = (access: ProviderAccess) =>
    run(chatGptPlanApi.changeOpenAiAccess(access), (status) => setView({ name: "loaded", status }));

  const disconnect = () =>
    run(chatGptPlanApi.disconnect(), ({ status, revocation }) => {
      setView({ name: "loaded", status });
      setNotice(
        revocation === "revoked"
          ? "Disconnected: OpenAI revoked Barrack's sign-in, and Barrack forgot it."
          : "Barrack forgot your sign-in, but OpenAI could not be reached to revoke it. Remove Barrack from your ChatGPT settings, under Security and login, to be sure.",
      );
    });

  return (
    <>
      {failure !== undefined && (
        <p className="error-notice" role="alert">
          {failure}
        </p>
      )}
      {notice !== undefined && <p className="quiet-note">{notice}</p>}
      {description.kind === "turned_off" && <p className="quiet-note">{description.explanation}</p>}
      {description.kind === "not_connected" && (
        <PlanSignIn
          lossNotice={description.lossNotice}
          signIn={signIn}
          isBusy={isBusy}
          onBegin={begin}
          onFinish={finish}
        />
      )}
      {description.kind === "connected" && (
        <>
          {isPlanInUseNoticeShown && (
            <div className="sandbox-banner" role="status">
              <strong>{planInUseNotice.title}</strong> {planInUseNotice.text}{" "}
              <button
                type="button"
                className="quiet-button"
                onClick={() => setIsPlanInUseNoticeShown(false)}
              >
                {planInUseNotice.dismissLabel}
              </button>
            </div>
          )}
          <p>
            Connected as <strong>{description.account}</strong> since {description.since}.{" "}
            <a href={chatGptUsageSettingsUrl} target="_blank" rel="noreferrer">
              Manage usage
            </a>
          </p>
          <OpenAiAccessChoice
            isOnPlan={description.isInUse}
            isBusy={isBusy}
            onChoose={chooseAccess}
          />
          <p className="quiet-note">
            Disconnecting revokes Barrack's sign-in at OpenAI and forgets it here; your OpenAI
            models then run on your API key.
          </p>
          <div className="sandbox-actions">
            <button type="button" className="danger-button" disabled={isBusy} onClick={disconnect}>
              Disconnect
            </button>
          </div>
        </>
      )}
      {description.kind === "not_connected" && view.status.openAiAccess === "chatgpt_plan" && (
        <OpenAiAccessChoice isOnPlan={true} isBusy={isBusy} onChoose={chooseAccess} />
      )}
    </>
  );
}

function PlanSignIn({
  lossNotice,
  signIn,
  isBusy,
  onBegin,
  onFinish,
}: {
  lossNotice: string | undefined;
  signIn: SignInUnderWay | undefined;
  isBusy: boolean;
  onBegin: () => void;
  onFinish: (finalAddress: string) => void;
}) {
  const [hasConsented, setHasConsented] = useState(false);
  const [finalAddress, setFinalAddress] = useState("");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onFinish(finalAddress);
  };

  return (
    <>
      {lossNotice !== undefined && (
        <p className="sandbox-banner sandbox-banner-warning">{lossNotice}</p>
      )}
      <h3>{planCardTitle}</h3>
      <p>{planCardText}</p>
      <ol className="sign-in-steps">
        {signInSteps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <label className="checkbox-field">
        <input
          type="checkbox"
          checked={hasConsented}
          onChange={(event) => setHasConsented(event.target.checked)}
        />
        Let my threads use my ChatGPT plan while I am away, for the work I give them.
      </label>
      <div className="sandbox-actions">
        <button
          type="button"
          className="primary-button"
          disabled={isBusy || !hasConsented}
          onClick={onBegin}
        >
          {continueWithChatGptLabel}
        </button>
      </div>
      {signIn !== undefined && (
        <form className="paste-address-form" onSubmit={submit}>
          <p className="quiet-note">
            If no tab opened,{" "}
            <a href={signIn.authorizationUrl} target="_blank" rel="noreferrer">
              open OpenAI's page
            </a>
            . This sign-in waits until{" "}
            {new Date(signIn.expiresAt).toLocaleTimeString(undefined, { timeStyle: "short" })}.
          </p>
          <label className="form-field">
            The address your browser ended on
            <input
              type="text"
              placeholder="http://127.0.0.1:1455/auth/callback?code=…"
              value={finalAddress}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setFinalAddress(event.target.value)}
            />
          </label>
          <div className="sandbox-actions">
            <button type="submit" className="primary-button" disabled={isBusy}>
              {isBusy ? "Connecting…" : "Finish connecting"}
            </button>
          </div>
        </form>
      )}
    </>
  );
}

function OpenAiAccessChoice({
  isOnPlan,
  isBusy,
  onChoose,
}: {
  isOnPlan: boolean;
  isBusy: boolean;
  onChoose: (access: ProviderAccess) => void;
}) {
  return (
    <fieldset className="access-choice" disabled={isBusy}>
      <legend>OpenAI models run on</legend>
      <label className="checkbox-field">
        <input
          type="radio"
          name="openai-access"
          checked={isOnPlan}
          onChange={() => onChoose("chatgpt_plan")}
        />
        Your ChatGPT plan
      </label>
      <label className="checkbox-field">
        <input
          type="radio"
          name="openai-access"
          checked={!isOnPlan}
          onChange={() => onChoose("api_key")}
        />
        Your OpenAI API key (under Model access)
      </label>
      <p className="quiet-note">
        A change applies to every thread from its next run. A thread is never moved from one to the
        other without your choosing it here.
      </p>
    </fieldset>
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
