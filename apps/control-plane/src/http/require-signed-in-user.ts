import type { Context, MiddlewareHandler } from "hono";
import type { AuthenticatedUser, Authenticator } from "../authentication/authenticator.js";
import { bearerTokenFrom } from "../bearer-token.js";
import { respondWithApiError } from "./api-error.js";

/** What the authentication middleware leaves for the routes after it. */
export type SignedInEnvironment = { Variables: { signedInUser: AuthenticatedUser } };

/**
 * Every API request but the few listed as public must carry
 * `Authorization: Bearer <access token>` for a user this installation admits.
 * It is mounted on all of `/api/*` before any route is added, so a route
 * added later is protected without having to ask, and a route can only learn
 * who is asking through `signedInUserOf`, which fails loudly if this did not
 * run. `http-app.test.ts` checks every registered API route refuses a request
 * without a token.
 */
export function requireSignedInUser(
  authenticator: Authenticator,
  publicPaths: ReadonlySet<string>,
): MiddlewareHandler<SignedInEnvironment> {
  return async (context, next) => {
    if (publicPaths.has(context.req.path)) {
      await next();
      return undefined;
    }
    const accessToken = bearerTokenFrom(context.req.header("authorization"));
    if (accessToken === undefined) {
      return respondUnauthorized(context, "Sign in first: this request carries no access token.");
    }
    const outcome = await authenticator.authenticate(accessToken);
    if (outcome.ok) {
      context.set("signedInUser", outcome.user);
      await next();
      return undefined;
    }
    switch (outcome.refusal) {
      case "not_authenticated":
        return respondUnauthorized(context, "The access token is not valid. Sign in again.");
      case "access_token_expired":
        return respondUnauthorized(
          context,
          "The access token has expired. Refresh it, or sign in again.",
        );
      case "not_allowed":
        return respondWithApiError(
          context,
          403,
          "not_allowed",
          "You are signed in, but this installation of Barrack does not let you use it. Ask whoever runs it to add your email address.",
        );
      case "unavailable":
        return respondWithApiError(
          context,
          503,
          "unavailable",
          "The control plane could not check who you are just now. Try again later.",
        );
    }
  };
}

/** The user the middleware authenticated; throws if the route is not behind it. */
export function signedInUserOf(context: Context<SignedInEnvironment>): AuthenticatedUser {
  const user = context.get("signedInUser");
  if (user === undefined) {
    throw new Error(`${context.req.path} was reached without the authentication middleware`);
  }
  return user;
}

/** https://www.rfc-editor.org/rfc/rfc6750#section-3 */
function respondUnauthorized(context: Context, message: string): Response {
  context.header("WWW-Authenticate", 'Bearer realm="barrack"');
  return respondWithApiError(context, 401, "unauthorized", message);
}
