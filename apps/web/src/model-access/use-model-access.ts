import type { ModelCatalogue, ModelCredentialSummary } from "@barrack/protocol";
import { useCallback, useEffect, useState } from "react";
import { useSession } from "../authentication/session-context";

export type ModelAccessView =
  | { name: "loading" }
  | { name: "failed"; reason: string }
  | { name: "loaded"; catalogue: ModelCatalogue; credentials: ModelCredentialSummary[] };

/**
 * The catalogue of models the agent supports and which providers the user
 * has a key for, loaded when the calling component mounts. `replaceCredentials`
 * takes the list a change answered with, so no second request is needed.
 */
export function useModelAccess(): {
  view: ModelAccessView;
  reload: () => void;
  replaceCredentials: (credentials: ModelCredentialSummary[]) => void;
} {
  const { modelAccessApi } = useSession();
  const [view, setView] = useState<ModelAccessView>({ name: "loading" });

  const reload = useCallback(() => {
    Promise.all([modelAccessApi.readCatalogue(), modelAccessApi.listCredentials()]).then(
      ([catalogue, credentials]) => setView({ name: "loaded", catalogue, credentials }),
      (error: unknown) =>
        setView({ name: "failed", reason: error instanceof Error ? error.message : String(error) }),
    );
  }, [modelAccessApi]);

  useEffect(reload, [reload]);

  const replaceCredentials = useCallback((credentials: ModelCredentialSummary[]) => {
    setView((current) => (current.name === "loaded" ? { ...current, credentials } : current));
  }, []);

  return { view, reload, replaceCredentials };
}
