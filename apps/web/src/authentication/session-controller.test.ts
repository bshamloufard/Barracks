import { describe, expect, it, vi } from "vitest";
import { SessionController } from "./session-controller";
import {
  accessTokenOf,
  type SessionLookup,
  type SignedInSession,
  type SignInService,
} from "./sign-in-service";

/** A sign-in service whose session the test changes, as supabase-js would on sign-in and refresh. */
class FakeSignInService implements SignInService {
  readonly hasSignIn = true;
  readonly sentCodes: string[] = [];
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

  async requestCode(emailAddress: string) {
    this.sentCodes.push(emailAddress);
  }

  async verifyCode(emailAddress: string, code: string) {
    if (code !== "123456") {
      throw new Error("That code did not work");
    }
    this.changeSession({ emailAddress, accessToken: "token-1" });
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

    session.requestCode("ada@example.com");
    await settle();
    session.submitCode("000000");
    await settle();
    const afterWrongCode = session.getState();
    session.submitCode("123456");
    await settle();

    expect(service.sentCodes).toEqual(["ada@example.com"]);
    expect(afterWrongCode).toMatchObject({ step: "code", errorMessage: "That code did not work" });
    expect(session.getState()).toEqual({ name: "signed_in", emailAddress: "ada@example.com" });
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
