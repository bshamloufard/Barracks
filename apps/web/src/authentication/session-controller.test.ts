import { describe, expect, it, vi } from "vitest";
import { SessionController } from "./session-controller";
import type { SignedInSession, SignInService } from "./sign-in-service";

/** A sign-in service whose session the test changes, as supabase-js would on sign-in and refresh. */
class FakeSignInService implements SignInService {
  readonly hasSignIn = true;
  readonly sentCodes: string[] = [];
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

  async restoreSession() {
    return this.#session;
  }

  async currentAccessToken() {
    return this.#session?.accessToken;
  }

  async refreshAccessToken() {
    return this.#session?.accessToken;
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
});
