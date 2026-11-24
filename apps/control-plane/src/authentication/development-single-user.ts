import type { AccessTokenVerification, AccessTokenVerifier } from "./access-token-verifier.js";

/**
 * Development mode's one user. The control plane hands this token to any
 * client that asks (`GET /api/client-configuration`), so it proves nothing:
 * the mode is allowed only on a loopback address, where the only clients are
 * on the developer's own machine. Requiring it anyway keeps development on
 * exactly the code paths a real sign-in uses.
 */
export const developmentUserId = "development-user";
export const developmentAccessToken = "development-single-user";

export class DevelopmentSingleUserVerifier implements AccessTokenVerifier {
  async verify(accessToken: string): Promise<AccessTokenVerification> {
    if (accessToken !== developmentAccessToken) {
      return {
        ok: false,
        failure: "invalid",
        detail: "Development mode accepts only its own fixed token",
      };
    }
    return {
      ok: true,
      identity: {
        userId: developmentUserId,
        confirmedEmailAddress: undefined,
        validUntil: undefined,
      },
    };
  }
}
