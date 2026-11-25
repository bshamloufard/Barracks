import type { ClientAuthenticationConfiguration } from "@barrack/protocol";
import { type ReactNode, useEffect, useState, useSyncExternalStore } from "react";
import { fetchClientConfiguration } from "../api/client-configuration";
import { DevelopmentSignInService } from "../authentication/development-sign-in-service";
import { SessionContext } from "../authentication/session-context";
import { SessionController } from "../authentication/session-controller";
import type { SignInReturn } from "../authentication/sign-in-link";
import type { SignInService } from "../authentication/sign-in-service";
import { NotAllowedPage } from "./not-allowed-page";
import { SignInPage } from "./sign-in-page";

type SessionSetup =
  | { name: "loading" }
  | { name: "failed"; reason: string }
  | { name: "ready"; session: SessionController };

/**
 * Asks the control plane how users sign in here, then shows the sign-in
 * page until someone is, the refusal page if this installation does not
 * admit them, and otherwise the page asked for, with the session provided.
 * `signInReturn` is what the address held when the page opened, if it
 * opened from a sign-in link.
 */
export function SessionGate({
  signInReturn,
  children,
}: {
  signInReturn: SignInReturn;
  children: ReactNode;
}) {
  const setup = useSessionSetup(signInReturn);
  if (setup.name === "loading") {
    return <Notice text="Loading…" />;
  }
  if (setup.name === "failed") {
    return <Notice text={setup.reason} isError={true} />;
  }
  return <SignedInOnly session={setup.session}>{children}</SignedInOnly>;
}

function SignedInOnly({ session, children }: { session: SessionController; children: ReactNode }) {
  const state = useSyncExternalStore(session.subscribe, session.getState);
  switch (state.name) {
    case "restoring":
      return <Notice text="Loading…" />;
    case "unavailable":
      return <Notice text={state.reason} isError={true} />;
    case "signed_out":
      return <SignInPage state={state} session={session} />;
    case "not_allowed":
      return <NotAllowedPage emailAddress={state.emailAddress} session={session} />;
    case "signed_in":
      return <SessionContext value={session}>{children}</SessionContext>;
  }
}

function useSessionSetup(signInReturn: SignInReturn): SessionSetup {
  const [setup, setSetup] = useState<SessionSetup>({ name: "loading" });
  useEffect(() => {
    let stopSession: (() => void) | undefined;
    let isCancelled = false;
    fetchClientConfiguration()
      .then(({ authentication }) => createSignInService(authentication))
      .then(
        (service) => {
          if (isCancelled) {
            return;
          }
          const session = new SessionController(service);
          stopSession = session.start(signInReturn);
          setSetup({ name: "ready", session });
        },
        (error: unknown) =>
          setSetup({
            name: "failed",
            reason: error instanceof Error ? error.message : String(error),
          }),
      );
    return () => {
      isCancelled = true;
      stopSession?.();
    };
  }, [signInReturn]);
  return setup;
}

/**
 * supabase-js is most of the page's code, so it is loaded only when the
 * installation signs users in with Supabase, never in development mode.
 */
async function createSignInService(
  authentication: ClientAuthenticationConfiguration,
): Promise<SignInService> {
  if (authentication.method === "development-single-user") {
    return new DevelopmentSignInService(authentication.accessToken);
  }
  const { SupabaseSignInService } = await import("../authentication/supabase-sign-in-service");
  return new SupabaseSignInService(
    authentication.supabaseUrl,
    authentication.supabasePublishableKey,
    window.location.href,
  );
}

function Notice({ text, isError = false }: { text: string; isError?: boolean }) {
  return (
    <main className="page">
      <p className={isError ? "error-notice" : "quiet-note"}>{text}</p>
    </main>
  );
}
