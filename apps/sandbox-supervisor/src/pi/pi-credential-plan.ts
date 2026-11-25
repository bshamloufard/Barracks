import { type ModelCredential, parseModelReference } from "@barrack/protocol";
import type { ModelAccess } from "../agent-harness.js";
import { isModelAccessUsable } from "../missing-model-access.js";

/** The model the running Pi was started on, and the credential its provider's requests use now. */
export type PiRunningOn = { model: string; credential: ModelCredential };

/** What Pi's credential file should hold: a credential for each provider it may use, by provider. */
export type PiCredentials = ReadonlyMap<string, ModelCredential>;

/**
 * Decides what Pi may use, from what the control plane last said and what
 * the running Pi was started on.
 *
 * Between runs, Pi gets the thread's model's credential alone. During a run
 * the run carries on with what it started with: a model switch takes effect
 * for the next run, as the control plane promises, so the running model's
 * provider keeps its credential beside the new model's until the run ends.
 * A credential for the running model's provider changes at once when it
 * can (a replaced key, read by Pi before its next request), and a removed
 * one is erased at once; one Pi could not use without starting again (a
 * key becoming a model proxy token, which needs another address, or a
 * token for the owner's API key becoming one for their ChatGPT plan) waits
 * for the run's end like a model switch.
 */
export function planPiCredentials(
  latest: ModelAccess | undefined,
  runningOn: PiRunningOn | undefined,
  isRunInProgress: boolean,
): Map<string, ModelCredential> {
  const credentials = new Map<string, ModelCredential>();
  const latestUsable = isModelAccessUsable(latest) ? latest : undefined;
  if (isRunInProgress && runningOn !== undefined) {
    const runningProvider = parseModelReference(runningOn.model).providerId;
    const runningProviderCredential = chooseRunningProviderCredential(latest, runningOn);
    if (runningProviderCredential !== undefined) {
      credentials.set(runningProvider, runningProviderCredential);
    }
  }
  if (latestUsable !== undefined) {
    const latestProvider = parseModelReference(latestUsable.model).providerId;
    if (!credentials.has(latestProvider)) {
      credentials.set(latestProvider, latestUsable.credential);
    }
  }
  return credentials;
}

function chooseRunningProviderCredential(
  latest: ModelAccess | undefined,
  runningOn: PiRunningOn,
): ModelCredential | undefined {
  const runningProvider = parseModelReference(runningOn.model).providerId;
  const latestProvider =
    latest?.model == null ? undefined : parseModelReference(latest.model).providerId;
  if (latestProvider !== runningProvider) {
    return runningOn.credential;
  }
  if (latest?.credential == null) {
    return undefined;
  }
  return isUsableWithoutRestart(runningOn.credential, latest.credential)
    ? latest.credential
    : runningOn.credential;
}

/**
 * Whether a running Pi can switch from one credential to the other: Pi
 * rereads its credential file before each request, but learns where a
 * provider's requests go, and how to shape them for a ChatGPT plan, only
 * when it starts.
 */
export function isUsableWithoutRestart(
  running: ModelCredential,
  replacement: ModelCredential,
): boolean {
  if (running.kind === "proxy_token" && replacement.kind === "proxy_token") {
    return running.baseUrl === replacement.baseUrl && running.access === replacement.access;
  }
  return running.kind === replacement.kind;
}

/** Whether Pi must be started again (or stopped) to run as the latest model access asks. */
export function isPiOutOfStep(
  latest: ModelAccess | undefined,
  runningOn: PiRunningOn | undefined,
): boolean {
  if (!isModelAccessUsable(latest)) {
    return runningOn !== undefined;
  }
  return (
    runningOn === undefined ||
    runningOn.model !== latest.model ||
    !isUsableWithoutRestart(runningOn.credential, latest.credential)
  );
}
