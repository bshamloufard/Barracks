import type { ModelCatalogue, ModelCredentialSummary } from "@barrack/protocol";
import { useCallback, useEffect, useState } from "react";
import type { ChatGptPlanApi } from "../api/chatgpt-plan-api";
import { useSession } from "../authentication/session-context";
import type { PlanInUse } from "./model-choices";

export type ModelAccessView =
  | { name: "loading" }
  | { name: "failed"; reason: string }
  | {
      name: "loaded";
      catalogue: ModelCatalogue;
      credentials: ModelCredentialSummary[];
      /** Where the user's OpenAI models run on their ChatGPT plan; undefined where they do not. */
      plan: PlanInUse | undefined;
    };

/**
 * The catalogue of models the agent supports, which providers the user
 * has a key for, and their ChatGPT plan where OpenAI's models run on it,
 * loaded when the calling component mounts. `replaceCredentials` takes the
 * list a change answered with, so no second request is needed.
 */
export function useModelAccess(): {
  view: ModelAccessView;
  reload: () => void;
  replaceCredentials: (credentials: ModelCredentialSummary[]) => void;
} {
  const { modelAccessApi, chatGptPlanApi } = useSession();
  const [view, setView] = useState<ModelAccessView>({ name: "loading" });

  const reload = useCallback(() => {
    Promise.all([
      modelAccessApi.readCatalogue(),
      modelAccessApi.listCredentials(),
      readPlanInUse(chatGptPlanApi),
    ]).then(
      ([catalogue, credentials, plan]) => setView({ name: "loaded", catalogue, credentials, plan }),
      (error: unknown) =>
        setView({ name: "failed", reason: error instanceof Error ? error.message : String(error) }),
    );
  }, [modelAccessApi, chatGptPlanApi]);

  useEffect(reload, [reload]);

  const replaceCredentials = useCallback((credentials: ModelCredentialSummary[]) => {
    setView((current) => (current.name === "loaded" ? { ...current, credentials } : current));
  }, []);

  return { view, reload, replaceCredentials };
}

/**
 * The plan, where the user's OpenAI models run on it, with its models; a
 * list OpenAI could not give leaves none listed, and the model can still be
 * typed.
 */
async function readPlanInUse(chatGptPlanApi: ChatGptPlanApi): Promise<PlanInUse | undefined> {
  const status = await chatGptPlanApi.readStatus();
  if (status.availability !== "available" || status.openAiAccess !== "chatgpt_plan") {
    return undefined;
  }
  if (status.connection === null) {
    return { isConnected: false, models: [] };
  }
  const models = await chatGptPlanApi.listModels().catch(() => []);
  return { isConnected: true, models };
}
