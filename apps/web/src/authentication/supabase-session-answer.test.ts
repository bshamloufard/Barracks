import {
  AuthApiError,
  AuthRefreshDiscardedError,
  AuthRetryableFetchError,
  AuthSessionMissingError,
  AuthUnknownError,
  type Session,
} from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { interpretSessionAnswer } from "./supabase-session-answer";

/**
 * The errors are supabase-js's own classes, built as its fetch layer builds
 * them for each kind of failure, so a change in how it classifies them
 * would show here.
 */

const session: Session = {
  access_token: "access-token",
  refresh_token: "refresh-token",
  expires_in: 3600,
  token_type: "bearer",
  user: {
    id: "4b1a7a52-0d2e-4d8e-9a43-3f0c5e1b2a10",
    email: "ada@example.com",
    aud: "authenticated",
    app_metadata: {},
    user_metadata: {},
    created_at: "2026-11-24T12:00:00Z",
  },
};

describe("interpreting supabase-js's answer about the session", () => {
  it("is signed in, with the token, whenever there is a session", () => {
    expect(interpretSessionAnswer(session, null)).toEqual({
      status: "signed_in",
      session: { emailAddress: "ada@example.com", accessToken: "access-token" },
    });
  });

  it("is signed out when no session is stored and nothing failed", () => {
    expect(interpretSessionAnswer(null, null)).toEqual({ status: "signed_out" });
  });

  it.each([
    ["no response at all (offline)", new AuthRetryableFetchError("Failed to fetch", 0)],
    ["a gateway timeout", new AuthRetryableFetchError("Gateway Timeout", 504)],
    ["a Cloudflare origin error", new AuthRetryableFetchError("HTTP 522", 522)],
    ["another tab replacing the session meanwhile", new AuthRefreshDiscardedError()],
  ])("is unavailable, keeping the session, when the refresh failed with %s", (_case, error) => {
    expect(interpretSessionAnswer(null, error)).toEqual({
      status: "unavailable",
      reason: `Could not refresh your sign-in with Supabase: ${error.message}`,
    });
  });

  it.each([
    [
      "a refresh token Supabase no longer accepts",
      new AuthApiError(
        "Invalid Refresh Token: Refresh Token Not Found",
        400,
        "refresh_token_not_found",
      ),
    ],
    ["a session Supabase has ended", new AuthSessionMissingError()],
    ["an answer supabase-js could not read", new AuthUnknownError("Unexpected token <", undefined)],
  ])(
    "is signed out when the refresh failed with %s, after which supabase-js keeps no session",
    (_case, error) => {
      expect(interpretSessionAnswer(null, error)).toEqual({ status: "signed_out" });
    },
  );
});
