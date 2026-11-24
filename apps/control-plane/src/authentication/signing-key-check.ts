import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { type CappedBackoff, delayAfterFailedAttempt } from "../capped-backoff.js";
import type { Logger } from "../logger.js";
import { type SupabaseProject, signingKeySetUrlOf } from "./supabase-project.js";

const keySetSchema = z.object({ keys: z.array(z.object({ kty: z.string() }).loose()) });

const asymmetricKeyTypes = new Set(["EC", "RSA", "OKP"]);

const requestTimeoutInMilliseconds = 10_000;

const defaultRetryBackoff: CappedBackoff = {
  firstDelayInMilliseconds: 1_000,
  longestDelayInMilliseconds: 30_000,
};

/** What fetching the key set came to: a key set Supabase published, or no usable answer. */
type KeySetAnswer =
  | { kind: "published"; asymmetricKeyCount: number }
  | { kind: "unanswered"; reason: string };

/**
 * Waits until the project's key set can be read, then fails, saying what to
 * do, unless it holds at least one public signing key. A project still
 * signing with Supabase's legacy shared secret publishes none, and the
 * control plane does not support it: it would have to hold that secret,
 * which can mint a token for anyone, or ask Supabase about every request.
 * https://supabase.com/docs/guides/auth/signing-keys
 *
 * Only that answer fails the start. Anything else (no connection, a timeout,
 * an error status, a page that is not a key set) may be Supabase being down
 * while the control plane restarts, so it is retried for as long as it takes,
 * as the database is: exiting would spend the host's bounded restarts and
 * leave the service down after Supabase came back. A wrong
 * BARRACK_SUPABASE_URL looks the same from here, so every retry's log says
 * to check it.
 */
export async function requireAsymmetricSigningKeys(
  project: SupabaseProject,
  logger: Logger,
  retryBackoff: CappedBackoff = defaultRetryBackoff,
): Promise<void> {
  const keySetUrl = signingKeySetUrlOf(project);
  for (let attempt = 1; ; attempt += 1) {
    const answer = await fetchKeySet(keySetUrl);
    if (answer.kind === "published") {
      requireAnAsymmetricKey(answer.asymmetricKeyCount);
      return;
    }
    const retryDelayInMilliseconds = delayAfterFailedAttempt(retryBackoff, attempt);
    logger.error(
      { keySetUrl: keySetUrl.href, reason: answer.reason, attempt, retryDelayInMilliseconds },
      "Could not read the Supabase project's signing keys; trying again. If this persists, check BARRACK_SUPABASE_URL",
    );
    await sleep(retryDelayInMilliseconds);
  }
}

async function fetchKeySet(keySetUrl: URL): Promise<KeySetAnswer> {
  let response: Response;
  try {
    response = await fetch(keySetUrl, {
      signal: AbortSignal.timeout(requestTimeoutInMilliseconds),
    });
  } catch (error) {
    return { kind: "unanswered", reason: describeFetchFailure(error) };
  }
  const keySet = keySetSchema.safeParse(await response.json().catch(() => undefined));
  if (!response.ok || !keySet.success) {
    return { kind: "unanswered", reason: `HTTP ${response.status} without a key set` };
  }
  const asymmetricKeyCount = keySet.data.keys.filter((key) =>
    asymmetricKeyTypes.has(key.kty),
  ).length;
  return { kind: "published", asymmetricKeyCount };
}

function requireAnAsymmetricKey(asymmetricKeyCount: number): void {
  if (asymmetricKeyCount === 0) {
    throw new Error(
      "The Supabase project publishes no public signing keys, so it still signs access tokens with the legacy shared secret, which Barrack does not support. In the Supabase dashboard, open Project Settings, JWT Keys, and rotate to an asymmetric signing key (ECC P-256 is recommended); then start the control plane again.",
    );
  }
}

/** Node's fetch says only "fetch failed"; the network error's code is in its cause. */
function describeFetchFailure(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const cause = error.cause;
  const causeCode =
    cause instanceof Error && "code" in cause && typeof cause.code === "string"
      ? cause.code
      : undefined;
  return causeCode === undefined ? error.message : `${error.message} (${causeCode})`;
}
