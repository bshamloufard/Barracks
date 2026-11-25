import { describe, expect, it, vi } from "vitest";
import { SessionController } from "./session-controller";
import { describeSignInLinkFailure } from "./sign-in-link";
import {
  accessTokenOf,
  type SessionLookup,
  type SignedInSession,
  type SignInService,
} from "./sign-in-service";

/** A sign-in service whose session the test changes, as supabase-js would on sign-in and refresh. */
class FakeSignInService implements SignInService {
  readonly hasSignIn = true;
  readonly sentEmails: string[] = [];
  readonly verifiedCodes: string[] = [];
  /** The auth code the one email this browser asked for would bring back. */
  linkAuthCode = "auth-code-1";
  signOutCount = 0;
  /** While set, every lookup answers this, as supabase-js does when a refresh cannot reach Supabase. */
  unreachableReason: string | undefined;
  #session: SignedInSession | undefined;
  readonly #listeners = new Set<(session: SignedInSession | undefined) => void>();

  constructor(session: SignedInSession | undefined) {
    this.#session = session;
  }

  changeSession(session: SignedInSession | undefined): void {
    this.#session = session;
    for (const listener of this.#listeners) {
      listener(session);
    }
  }

  async restoreSession(): Promise<SessionLookup> {
    if (this.unreachableReason !== undefined) {
      return { status: "unavailable", reason: this.unreachableReason };
    }
    return this.#session === undefined
      ? { status: "signed_out" }
      : { status: "signed_in", session: this.#session };
  }

  async currentAccessToken() {
    return accessTokenOf(await this.restoreSession());
  }

  async refreshAccessToken() {
    return this.currentAccessToken();
  }

  async sendSignInEmail(emailAddress: string) {
    this.sentEmails.push(emailAddress);
  }

  async verifyCode(emailAddress: string, code: string) {
    this.verifiedCodes.push(code);
    if (!["123456", "12345678", "1234567890"].includes(code)) {
      throw new Error("That code did not work");
    }
    this.changeSession({ emailAddress, accessToken: "token-1" });
  }

  /** As supabase-js does, it fails when this browser holds no verifier for the code. */
  async finishSignInWithLink(authCode: string) {
    if (authCode !== this.linkAuthCode) {
      throw new Error(describeSignInLinkFailure({ kind: "not_this_browser" }));
    }
    this.changeSession({ emailAddress: "ada@example.com", accessToken: "token-1" });
  }

  async signOut() {
    this.signOutCount += 1;
    this.changeSession(undefined);
  }

  onSessionChanged(listener: (session: SignedInSession | undefined) => void) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("the page's session", () => {
  it("signs in with the code emailed to the address", async () => {
    const service = new FakeSignInService(undefined);
    const session = new SessionController(service);
    session.start();
    await settle();

    session.requestSignInEmail("ada@example.com");
    await settle();
    session.submitCode("000000");
    await settle();
    const afterWrongCode = session.getState();
    session.submitCode("123456");
    await settle();

    expect(service.sentEmails).toEqual(["ada@example.com"]);
    expect(afterWrongCode).toMatchObject({
      step: "check_email",
      errorMessage: "That code did not work",
    });
    expect(session.getState()).toEqual({ name: "signed_in", emailAddress: "ada@example.com" });
  });

  it.each(["123456", "12345678", "1234567890"])(
    "accepts a code of %s, as long as Supabase may send",
    async (code) => {
      const service = new FakeSignInService(undefined);
      const session = new SessionController(service);
      session.start();
      await settle();

      session.requestSignInEmail("ada@example.com");
      await settle();
      session.submitCode(code);
      await settle();

      expect(service.verifiedCodes).toEqual([code]);
      expect(session.getState()).toEqual({ name: "signed_in", emailAddress: "ada@example.com" });
    },
  );

  it.each(["12345", "12345678901", "12 34 56", "abcdef", ""])(
    "refuses %j without asking Supabase, since no code Supabase sends looks like it",
    async (code) => {
      const service = new FakeSignInService(undefined);
      const session = new SessionController(service);
      session.start();
      await settle();

      session.requestSignInEmail("ada@example.com");
      await settle();
      session.submitCode(code);
      await settle();

      expect(service.verifiedCodes).toEqual([]);
      expect(session.getState()).toMatchObject({
        step: "check_email",
        isBusy: false,
        errorMessage: "A code is 6 to 10 digits. Check it against the email.",
      });
    },
  );

  it("signs in when the page opens from the link this browser asked for", async () => {
    const service = new FakeSignInService(undefined);
    const session = new SessionController(service);

    session.start({ kind: "link", authCode: "auth-code-1" });
    await settle();

    expect(session.getState()).toEqual({ name: "signed_in", emailAddress: "ada@example.com" });
  });

  it("explains a link opened in a browser that did not ask for it, and lets the user ask here", async () => {
    const service = new FakeSignInService(undefined);
    const session = new SessionController(service);

    session.start({ kind: "link", authCode: "a-code-another-browser-asked-for" });
    await settle();
    const afterLink = session.getState();
    session.requestSignInEmail("ada@example.com");
    await settle();

    expect(afterLink).toMatchObject({
      name: "signed_out",
      step: "email",
      errorMessage: expect.stringContaining("works only in the browser that asked for it"),
    });
    expect(service.sentEmails).toEqual(["ada@example.com"]);
    expect(session.getState()).toMatchObject({ step: "check_email", errorMessage: undefined });
  });

  it.each([
    ["expired or reused", "otp_expired", "has expired or has been used already"],
    ["unknown", "something_new", "Supabase did not accept that sign-in link."],
  ])(
    "shows why Supabase refused a %s link, and lets the user ask again",
    async (_case, errorCode, reason) => {
      const service = new FakeSignInService(undefined);
      const session = new SessionController(service);

      session.start({ kind: "refused", errorCode });
      await settle();
      const afterLink = session.getState();
      session.requestSignInEmail("ada@example.com");
      await settle();

      expect(afterLink).toMatchObject({
        name: "signed_out",
        step: "email",
        isBusy: false,
        errorMessage: expect.stringContaining(reason),
      });
      expect(afterLink).toMatchObject({
        errorMessage: expect.stringContaining("Ask for a new one here."),
      });
      expect(session.getState()).toMatchObject({ step: "check_email" });
    },
  );

  it("says nothing of a stale link when this browser is signed in already", async () => {
    const service = new FakeSignInService({ emailAddress: "grace@example.com", accessToken: "t" });
    const session = new SessionController(service);

    session.start({ kind: "refused", errorCode: "otp_expired" });
    await settle();

    expect(session.getState()).toEqual({ name: "signed_in", emailAddress: "grace@example.com" });
  });

  it("passes every refreshed token to open connections, and not the first one", async () => {
    const service = new FakeSignInService({
      emailAddress: "ada@example.com",
      accessToken: "token-1",
    });
    const session = new SessionController(service);
    const sentToConnection = vi.fn();
    session.onAccessTokenRefreshed(sentToConnection);
    session.start();
    await settle();

    service.changeSession({ emailAddress: "ada@example.com", accessToken: "token-1" });
    service.changeSession({ emailAddress: "ada@example.com", accessToken: "token-2" });

    expect(sentToConnection.mock.calls).toEqual([["token-2"]]);
  });

  it("shows a refused user as not allowed until they sign out", async () => {
    const service = new FakeSignInService({ emailAddress: "grace@example.com", accessToken: "t" });
    const session = new SessionController(service);
    session.start();
    await settle();

    session.reportNotAllowed();
    const refused = session.getState();
    await session.signOut();

    expect(refused).toEqual({ name: "not_allowed", emailAddress: "grace@example.com" });
    expect(session.getState()).toMatchObject({ name: "signed_out", step: "email" });
  });

  it("signs out when the control plane will not accept even a refreshed token", async () => {
    const service = new FakeSignInService({ emailAddress: "ada@example.com", accessToken: "t" });
    const session = new SessionController(service);
    session.start();
    await settle();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ error: { code: "unauthorized", message: "No" } }, { status: 401 }),
      ),
    );

    await expect(session.threadsApi.listThreads()).rejects.toThrow(/No/);
    await settle();
    vi.unstubAllGlobals();

    expect(session.getState()).toMatchObject({ name: "signed_out" });
  });

  it("keeps a stored session it cannot refresh at startup, and signs in once it can", async () => {
    vi.useFakeTimers();
    const service = new FakeSignInService({ emailAddress: "ada@example.com", accessToken: "t" });
    service.unreachableReason = "Could not refresh your sign-in with Supabase: Failed to fetch";
    const session = new SessionController(service);
    const stop = session.start();
    await vi.advanceTimersByTimeAsync(0);
    const whileOffline = session.getState();

    service.unreachableReason = undefined;
    await vi.advanceTimersByTimeAsync(10_000);
    stop();
    vi.useRealTimers();

    expect(whileOffline).toEqual({
      name: "unavailable",
      reason: "Could not refresh your sign-in with Supabase: Failed to fetch",
    });
    expect(session.getState()).toEqual({ name: "signed_in", emailAddress: "ada@example.com" });
    expect(service.signOutCount).toBe(0);
  });

  it("does not sign out when a request finds no token can be had while offline", async () => {
    const service = new FakeSignInService({ emailAddress: "ada@example.com", accessToken: "t" });
    const session = new SessionController(service);
    session.start();
    await settle();
    service.unreachableReason = "Could not refresh your sign-in with Supabase: Failed to fetch";

    await expect(session.threadsApi.listThreads()).rejects.toThrow(/still signed in/);
    await settle();

    expect(service.signOutCount).toBe(0);
    expect(session.getState()).toMatchObject({ name: "signed_in" });
  });
});
