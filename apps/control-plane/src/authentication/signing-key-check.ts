import { z } from "zod";
import { type SupabaseProject, signingKeySetUrlOf } from "./supabase-project.js";

const keySetSchema = z.object({ keys: z.array(z.object({ kty: z.string() }).loose()) });

const asymmetricKeyTypes = new Set(["EC", "RSA", "OKP"]);

const requestTimeoutInMilliseconds = 10_000;

/**
 * Fails, saying what to do, unless the project publishes at least one
 * public signing key. A project still signing with Supabase's legacy shared
 * secret publishes none, and the control plane does not support it: it would
 * have to hold that secret, which can mint a token for anyone, or ask
 * Supabase about every request. Checked once at startup, so a project that
 * cannot sign anyone in is found before anyone tries.
 * https://supabase.com/docs/guides/auth/signing-keys
 */
export async function requireAsymmetricSigningKeys(project: SupabaseProject): Promise<void> {
  const keySetUrl = signingKeySetUrlOf(project);
  let response: Response;
  try {
    response = await fetch(keySetUrl, {
      signal: AbortSignal.timeout(requestTimeoutInMilliseconds),
    });
  } catch (error) {
    throw new Error(
      `Could not fetch the Supabase project's signing keys from ${keySetUrl.href}. Check BARRACK_SUPABASE_URL.`,
      { cause: error },
    );
  }
  const keySet = keySetSchema.safeParse(await response.json().catch(() => undefined));
  if (!response.ok || !keySet.success) {
    throw new Error(
      `${keySetUrl.href} answered HTTP ${response.status} without a key set. Check BARRACK_SUPABASE_URL.`,
    );
  }
  const asymmetricKeyCount = keySet.data.keys.filter((key) =>
    asymmetricKeyTypes.has(key.kty),
  ).length;
  if (asymmetricKeyCount === 0) {
    throw new Error(
      "The Supabase project publishes no public signing keys, so it still signs access tokens with the legacy shared secret, which Barrack does not support. In the Supabase dashboard, open Project Settings, JWT Keys, and rotate to an asymmetric signing key (ECC P-256 is recommended); then start the control plane again.",
    );
  }
}
