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

export type ConfiguredAuthentication = {
  authenticator: Authenticator;
  /** What clients are told about signing in, at `GET /api/client-configuration`. */
  clientAuthentication: ClientAuthenticationConfiguration;
};

/**
 * Builds the authenticator for the configured method. With Supabase it first
 * checks the project publishes signing keys, failing the start if not.
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
    return {
      authenticator: new Authenticator({
        verifier: new DevelopmentSingleUserVerifier(),
        admission: { kind: "anyone-who-can-sign-in" },
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
  await requireAsymmetricSigningKeys(project);
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
    authenticator: new Authenticator({ verifier, admission, userStore, logger }),
    clientAuthentication: {
      method: "supabase",
      supabaseUrl: project.url,
      supabasePublishableKey: project.publishableKey,
    },
  };
}
