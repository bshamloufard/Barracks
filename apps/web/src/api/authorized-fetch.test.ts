import { describe, expect, it, vi } from "vitest";
import type { AccessTokenLookup, AccessTokenSource } from "../authentication/sign-in-service";
import { createAuthorizedFetch } from "./authorized-fetch";

/** Tokens that change only when refreshed, as supabase-js hands them out. */
function tokensStartingAt(firstToken: string): AccessTokenSource {
  let current = firstToken;
  let refreshCount = 0;
  return {
    currentAccessToken: async () => ({ status: "available", accessToken: current }),
    refreshAccessToken: async () => {
      refreshCount += 1;
      current = `refreshed-${refreshCount}`;
      return { status: "available", accessToken: current };
    },
  };
}

/** A source that answers `firstAnswer` for the current token and `refreshAnswer` for a refresh. */
function tokensRefreshingTo(
  firstAnswer: AccessTokenLookup,
  refreshAnswer: AccessTokenLookup = firstAnswer,
): AccessTokenSource {
  return {
    currentAccessToken: async () => firstAnswer,
    refreshAccessToken: async () => refreshAnswer,
  };
}

const offline: AccessTokenLookup = {
  status: "unavailable",
  reason: "Could not refresh your sign-in with Supabase: Failed to fetch",
};

/** A control plane that accepts only the listed tokens, and answers the rest with `refusal`. */
function controlPlaneAccepting(acceptedTokens: string[], refusal = 401) {
  const tokensSeen: Array<string | null> = [];
  const send = vi.fn(async (_path: string, init: RequestInit) => {
    const authorization = new Headers(init.headers).get("Authorization");
    tokensSeen.push(authorization);
    const isAccepted = acceptedTokens.some((token) => authorization === `Bearer ${token}`);
    if (isAccepted) {
      return Response.json({ threads: [] });
    }
    const code = refusal === 403 ? "not_allowed" : "unauthorized";
    return Response.json({ error: { code, message: "Refused" } }, { status: refusal });
  });
  return { send, tokensSeen };
}

function handlers() {
  return { onSignInRequired: vi.fn(), onNotAllowed: vi.fn() };
}

describe("an authorized request", () => {
  it("carries the current access token", async () => {
    const controlPlane = controlPlaneAccepting(["token-1"]);
    const refusals = handlers();
    const authorizedFetch = createAuthorizedFetch(
      tokensStartingAt("token-1"),
      refusals,
      controlPlane.send,
    );

    const response = await authorizedFetch("/api/threads");

    expect(response.status).toBe(200);
    expect(controlPlane.tokensSeen).toEqual(["Bearer token-1"]);
    expect(refusals.onSignInRequired).not.toHaveBeenCalled();
  });

  it("refreshes a refused token and tries once more", async () => {
    const controlPlane = controlPlaneAccepting(["refreshed-1"]);
    const refusals = handlers();
    const authorizedFetch = createAuthorizedFetch(
      tokensStartingAt("stale"),
      refusals,
      controlPlane.send,
    );

    const response = await authorizedFetch("/api/threads");

    expect(response.status).toBe(200);
    expect(controlPlane.tokensSeen).toEqual(["Bearer stale", "Bearer refreshed-1"]);
    expect(refusals.onSignInRequired).not.toHaveBeenCalled();
  });

  it("asks the user to sign in again when even a refreshed token is refused", async () => {
    const controlPlane = controlPlaneAccepting([]);
    const refusals = handlers();
    const authorizedFetch = createAuthorizedFetch(
      tokensStartingAt("stale"),
      refusals,
      controlPlane.send,
    );

    const response = await authorizedFetch("/api/threads");

    expect(response.status).toBe(401);
    expect(controlPlane.tokensSeen).toHaveLength(2);
    expect(refusals.onSignInRequired).toHaveBeenCalledOnce();
  });

  it("reports a user this installation does not admit, without retrying", async () => {
    const controlPlane = controlPlaneAccepting([], 403);
    const refusals = handlers();
    const authorizedFetch = createAuthorizedFetch(
      tokensStartingAt("token-1"),
      refusals,
      controlPlane.send,
    );

    const response = await authorizedFetch("/api/threads");

    expect(response.status).toBe(403);
    expect(controlPlane.tokensSeen).toEqual(["Bearer token-1"]);
    expect(refusals.onNotAllowed).toHaveBeenCalledOnce();
  });

  it("fails the request without signing out when no token can be had while offline", async () => {
    const controlPlane = controlPlaneAccepting([]);
    const refusals = handlers();
    const authorizedFetch = createAuthorizedFetch(
      tokensRefreshingTo(offline),
      refusals,
      controlPlane.send,
    );

    await expect(authorizedFetch("/api/threads")).rejects.toThrow(
      /Failed to fetch\. You are still signed in/,
    );
    expect(controlPlane.tokensSeen).toEqual([]);
    expect(refusals.onSignInRequired).not.toHaveBeenCalled();
  });

  it("fails the request without signing out when a refused token cannot be refreshed while offline", async () => {
    const controlPlane = controlPlaneAccepting([]);
    const refusals = handlers();
    const authorizedFetch = createAuthorizedFetch(
      tokensRefreshingTo({ status: "available", accessToken: "stale" }, offline),
      refusals,
      controlPlane.send,
    );

    await expect(authorizedFetch("/api/threads")).rejects.toThrow(/still signed in/);
    expect(controlPlane.tokensSeen).toEqual(["Bearer stale"]);
    expect(refusals.onSignInRequired).not.toHaveBeenCalled();
  });

  it("asks the user to sign in again, sending nothing, when the session is definitely gone", async () => {
    const controlPlane = controlPlaneAccepting([]);
    const refusals = handlers();
    const authorizedFetch = createAuthorizedFetch(
      tokensRefreshingTo({ status: "signed_out" }),
      refusals,
      controlPlane.send,
    );

    await expect(authorizedFetch("/api/threads")).rejects.toThrow(/signed out/);
    expect(controlPlane.tokensSeen).toEqual([]);
    expect(refusals.onSignInRequired).toHaveBeenCalledOnce();
  });
});
