import type { ClientAuthenticationConfiguration } from "@barrack/protocol";
import type { Logger } from "../logger.js";
import type { UserStore } from "../users/user-store.js";
import type { AuthenticationConfiguration } from "./authentication-configuration.js";
import { Authenticator } from "./authenticator.js";
import {
  DevelopmentSingleUserVerifier,
  developmentAccessToken,
} from "./development-single-user.js";
import { requireAsymmetricSigningKeys } from "./signing-key-check.js";
import { SupabaseAccessTokenVerifier } from "./supabase-access-token-verifier.js";
import type { UserAdmission } from "./user-admission.js";

export type ConfiguredAuthentication = {
  authenticator: Authenticator;
  /** What clients are told about signing in, at `GET /api/client-configuration`. */
  clientAuthentication: ClientAuthenticationConfiguration;
  /** Who is admitted, which the model proxy asks again of a thread's owner. */
  admission: UserAdmission;
};

/**
 * Builds the authenticator for the configured method. With Supabase it first
 * waits until the project's signing keys can be read, and fails the start if
 * they are not asymmetric.
 */
export async function createConfiguredAuthentication(
  configuration: AuthenticationConfiguration,
  userStore: UserStore,
  logger: Logger,
): Promise<ConfiguredAuthentication> {
  if (configuration.method === "development-single-user") {
    logger.warn(
      "Authentication is development-single-user: there is no sign-in, and every client is one fixed user. For a control plane on this machine only.",
    );
    const admission: UserAdmission = { kind: "anyone-who-can-sign-in" };
    return {
      admission,
      authenticator: new Authenticator({
        verifier: new DevelopmentSingleUserVerifier(),
        admission,
        userStore,
        logger,
      }),
      clientAuthentication: {
        method: "development-single-user",
        accessToken: developmentAccessToken,
      },
    };
  }
  const { project, admission } = configuration;
  // The server does not listen until this passes, as it does not until the
  // database is migrated: no token could be verified without the key set,
  // and a health check that fails meanwhile keeps a host from replacing a
  // working deployment with this one.
  await requireAsymmetricSigningKeys(project, logger);
  logger.info(
    {
      supabaseUrl: project.url,
      issuer: project.issuer,
      admission:
        admission.kind === "anyone-who-can-sign-in"
          ? admission.kind
          : `${admission.emailAddresses.size} listed email address(es)`,
    },
    "Signing users in with Supabase Auth",
  );
  if (admission.kind === "anyone-who-can-sign-in") {
    logger.warn(
      "Anyone who can sign in to the Supabase project may use this installation and spend its sandbox budget. Turn off sign-ups in Supabase, or list the allowed addresses in BARRACK_ALLOWED_USER_EMAILS.",
    );
  }
  const verifier = new SupabaseAccessTokenVerifier({
    project,
    confirmEmailAddresses: admission.kind === "listed-email-addresses",
  });
  return {
    admission,
    authenticator: new Authenticator({ verifier, admission, userStore, logger }),
    clientAuthentication: {
      method: "supabase",
      supabaseUrl: project.url,
      supabasePublishableKey: project.publishableKey,
    },
  };
}
