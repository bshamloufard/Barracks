import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SignedInSession } from "./sign-in-service";
import { SupabaseSignInService } from "./supabase-sign-in-service";

/**
 * supabase-js's own code runs here, with only `fetch` replaced by a
 * stand-in that answers as Supabase Auth's API does, so what is checked is
 * what supabase-js sends and how it treats each answer. Outside a browser
 * it keeps the code verifier in memory, one store per client, as a browser
 * keeps it in that browser's storage.
 */

type SentRequest = { url: string; body: Record<string, unknown> };

const supabaseUrl = "https://project-ref.supabase.co";
const publishableKey = "sb_publishable_test";

let sent: SentRequest[];
let answerToken: () => Response;

const issuedSession = {
  access_token: "access-token-1",
  refresh_token: "refresh-token-1",
  expires_in: 3600,
  token_type: "bearer",
  user: {
    id: "4b1a7a52-0d2e-4d8e-9a43-3f0c5e1b2a10",
    email: "ada@example.com",
    aud: "authenticated",
    app_metadata: {},
    user_metadata: {},
    created_at: "2026-11-25T12:00:00Z",
  },
};

beforeEach(() => {
  sent = [];
  answerToken = () => Response.json(issuedSession);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      sent.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
      if (url.startsWith(`${supabaseUrl}/auth/v1/otp`)) {
        return Response.json({});
      }
      if (url === `${supabaseUrl}/auth/v1/token?grant_type=pkce`) {
        return answerToken();
      }
      return Response.json({ code: "not_found", message: "Not found" }, { status: 404 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function serviceAt(pageAddress = "https://barrack.example.com/"): SupabaseSignInService {
  return new SupabaseSignInService(supabaseUrl, publishableKey, pageAddress);
}

describe("signing in with Supabase by email", () => {
  it("sends the link back to the installation's own origin, whatever the page's address held", async () => {
    const service = serviceAt(
      "https://barrack.example.com/?thread=thread-1&next=https://evil.example#x",
    );

    await service.sendSignInEmail("ada@example.com");

    expect(sent).toHaveLength(1);
    const otpRequest = new URL(sent[0]?.url ?? "");
    expect(otpRequest.pathname).toBe("/auth/v1/otp");
    expect([...otpRequest.searchParams]).toEqual([["redirect_to", "https://barrack.example.com"]]);
    expect(sent[0]?.body).toMatchObject({
      email: "ada@example.com",
      create_user: true,
      code_challenge_method: "s256",
      code_challenge: expect.any(String),
    });
  });

  it("signs in with the code a link brings back, using the verifier stored when it asked", async () => {
    const service = serviceAt();
    const sessions: (SignedInSession | undefined)[] = [];
    service.onSessionChanged((session) => sessions.push(session));

    await service.sendSignInEmail("ada@example.com");
    await service.finishSignInWithLink("6b1c2a77-9d8e-4f6a-8c1b-2e3d4f5a6b7c");

    expect(sent[1]?.url).toBe(`${supabaseUrl}/auth/v1/token?grant_type=pkce`);
    expect(sent[1]?.body).toEqual({
      auth_code: "6b1c2a77-9d8e-4f6a-8c1b-2e3d4f5a6b7c",
      code_verifier: expect.stringMatching(/^[A-Za-z0-9._~-]{43,128}$/),
    });
    expect(sessions.at(-1)).toEqual({
      emailAddress: "ada@example.com",
      accessToken: "access-token-1",
    });
    expect(await service.restoreSession()).toMatchObject({ status: "signed_in" });
  });

  it("explains a link opened in a browser that did not ask for it, without asking Supabase", async () => {
    const service = serviceAt();

    await expect(service.finishSignInWithLink("a-code-asked-for-elsewhere")).rejects.toThrow(
      "That sign-in link was not asked for in this browser, or this browser has used up its request already: a link works only in the browser that asked for it. Ask for a new one here, and open it in this browser.",
    );
    expect(sent).toEqual([]);
  });

  it.each([
    ["flow_state_not_found", "has expired or has been used already"],
    ["flow_state_expired", "has expired or has been used already"],
    ["bad_code_verifier", "is from an earlier email"],
  ])("explains a link whose code Supabase refuses with %s", async (errorCode, reason) => {
    const service = serviceAt();
    answerToken = () =>
      Response.json(
        { code: 400, error_code: errorCode, msg: "invalid flow state" },
        { status: 400 },
      );

    await service.sendSignInEmail("ada@example.com");

    await expect(service.finishSignInWithLink("6b1c2a77")).rejects.toThrow(reason);
    expect(await service.restoreSession()).toEqual({ status: "signed_out" });
  });

  it("cannot be tried again once a link failed, since the verifier is gone", async () => {
    const service = serviceAt();
    answerToken = () =>
      Response.json({ error_code: "flow_state_expired", msg: "x" }, { status: 400 });

    await service.sendSignInEmail("ada@example.com");
    await service.finishSignInWithLink("first").catch(() => undefined);

    await expect(service.finishSignInWithLink("second")).rejects.toThrow(
      "not asked for in this browser",
    );
  });
});
