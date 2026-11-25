import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { ChatGptPlanSignInStart } from "@barrack/protocol";
import type { Logger } from "../logger.js";
import type { ChatGptPlanStore, PlanSignIn, SignInAttempt } from "./chatgpt-plan-store.js";
import {
  type ChatGptSignInClient,
  dynamicRegistrationClientId,
  IdTokenRejectedError,
  type IssuedTokens,
  planScope,
  planUsageScope,
  type TokenFailure,
} from "./chatgpt-sign-in-client.js";
import {
  callbackHost,
  callbackPath,
  type FinalAddressProblem,
  readFinalAddress,
} from "./final-address.js";

/**
 * Connecting a user's ChatGPT plan: OpenAI's Authorization Code flow with
 * PKCE, `state` and an OpenID nonce, done by the control plane itself, as
 * https://developers.openai.com/siwc/token-sharing-open-source/sign-in
 * describes.
 *
 * The programme sends the browser back to `127.0.0.1`, the machine the
 * browser runs on, and has no flow without a browser, so the control plane
 * never receives that request: the user pastes the address their browser
 * ended on (`finish`). A sign-in begun is kept, its secrets sealed, for ten
 * minutes, and finishes once; the code in the address is spent within a
 * minute or so by OpenAI's rules, so the page asks for it at once.
 *
 * The first sign-in of a user registers a client of OpenAI's
 * (`dynamic_agent_client`, with the app's name), which comes back with the
 * callback; it is kept and used for every later sign-in, with the same
 * `ext_agent_host_id`, made once per user for this installation.
 *
 * Nothing secret is logged: not the address, the code, the verifier, the
 * nonce or any token; only outcomes and OpenAI's error codes.
 */

/** How long a sign-in begun waits for the user to paste the address. */
export const signInAttemptLifetimeInMilliseconds = 10 * 60_000;

/**
 * The port in the address OpenAI sends the browser to. Nothing listens
 * there: the user copies the address. The documentation's own example.
 */
export const callbackPort = 1455;

/** Finished attempts are kept a day past their expiry, to say an address was used already. */
const finishedAttemptRetentionInMilliseconds = 24 * 60 * 60_000;

export type SignInFinish = { kind: "connected" } | { kind: "failed"; message: string };

export type ChatGptSignInOptions = {
  store: ChatGptPlanStore;
  client: ChatGptSignInClient;
  clock?: () => Date;
  logger: Logger;
};

export class ChatGptSignIn {
  readonly #store: ChatGptPlanStore;
  readonly #client: ChatGptSignInClient;
  readonly #clock: () => Date;
  readonly #logger: Logger;

  constructor(options: ChatGptSignInOptions) {
    this.#store = options.store;
    this.#client = options.client;
    this.#clock = options.clock ?? (() => new Date());
    this.#logger = options.logger;
  }

  /** Begins a sign-in: the address of OpenAI's page, for the user to open. */
  async start(ownerUserId: string): Promise<ChatGptPlanSignInStart> {
    const now = this.#clock();
    const plan = await this.#store.findOrCreatePlan(ownerUserId, `urn:uuid:${randomUUID()}`);
    const signedIn = await this.#store.readSignIn(ownerUserId);
    const state = randomText();
    const codeVerifier = randomText();
    const nonce = randomText();
    const attempt: SignInAttempt = {
      ownerUserId,
      stateDigest: digestOf(state),
      clientId: plan.clientId ?? dynamicRegistrationClientId,
      redirectUri: `http://${callbackHost}:${callbackPort}${callbackPath}`,
      secrets: { codeVerifier, nonce },
      startedAt: now,
      expiresAt: new Date(now.getTime() + signInAttemptLifetimeInMilliseconds),
    };
    await this.#store.removeAttemptsExpiredBefore(
      new Date(now.getTime() - finishedAttemptRetentionInMilliseconds),
    );
    await this.#store.saveAttempt(attempt);
    const authorizationUrl = await this.#client.buildAuthorizationUrl({
      clientId: attempt.clientId,
      hostId: plan.hostId,
      redirectUri: attempt.redirectUri,
      state,
      nonce,
      codeChallenge: createHash("sha256").update(codeVerifier).digest("base64url"),
      loginHint: signedIn?.accountEmail,
    });
    this.#logger.info(
      { ownerUserId, isFirstRegistration: plan.clientId === undefined },
      "Began a ChatGPT plan sign-in",
    );
    return { authorizationUrl, expiresAt: attempt.expiresAt.toISOString() };
  }

  /** Finishes a sign-in with the address the user's browser ended on. */
  async finish(ownerUserId: string, pastedAddress: string): Promise<SignInFinish> {
    const reading = readFinalAddress(pastedAddress);
    if (reading.kind === "unreadable") {
      return this.#fail(ownerUserId, reading.problem, describeUnreadableAddress(reading.problem));
    }
    if (reading.state === undefined) {
      return this.#fail(ownerUserId, "cut_short", describeUnreadableAddress("cut_short"));
    }
    const taking = await this.#store.takeAttempt(
      ownerUserId,
      digestOf(reading.state),
      this.#clock(),
    );
    if (taking.kind !== "taken") {
      return this.#fail(ownerUserId, taking.kind, describeUntakenAttempt(taking.kind));
    }
    if (reading.kind === "declined") {
      return this.#fail(ownerUserId, "declined", declinedMessage);
    }
    if (reading.kind === "refused_by_openai") {
      return this.#fail(
        ownerUserId,
        reading.error,
        describeOpenAiRefusal(reading.error, reading.description),
      );
    }
    const clientId = chooseClientId(taking.attempt, reading.clientId);
    if (clientId === undefined) {
      return this.#fail(ownerUserId, "client_mismatch", clientMismatchMessage);
    }
    const exchanged = await this.#client.exchangeCode({
      clientId,
      code: reading.code,
      codeVerifier: taking.attempt.secrets.codeVerifier,
      redirectUri: taking.attempt.redirectUri,
    });
    if (exchanged.kind === "token_failure") {
      return this.#failExchange(ownerUserId, exchanged);
    }
    // What OpenAI granted: as the token answer says; where it does not, as
    // the callback said; where neither does, what was asked (RFC 6749, 5.1).
    const grantedScopes = exchanged.tokens.scopes ?? reading.scopes ?? planScope.split(" ");
    return this.#connect(ownerUserId, clientId, taking.attempt, {
      ...exchanged.tokens,
      scopes: grantedScopes,
    });
  }

  async #connect(
    ownerUserId: string,
    clientId: string,
    attempt: SignInAttempt,
    tokens: IssuedTokens,
  ): Promise<SignInFinish> {
    // Tokens OpenAI issued but that are not kept are revoked, so none is left live there.
    const issued = { clientId, refreshToken: tokens.refreshToken };
    if (!tokens.scopes?.includes(planUsageScope)) {
      await this.#revoke(ownerUserId, issued);
      return this.#fail(ownerUserId, "plan_usage_not_granted", planUsageNotGrantedMessage);
    }
    if (tokens.idToken === undefined) {
      await this.#revoke(ownerUserId, issued);
      return this.#fail(ownerUserId, "id_token_missing", unverifiableMessage);
    }
    let account: Awaited<ReturnType<ChatGptSignInClient["verifyIdToken"]>>;
    try {
      account = await this.#client.verifyIdToken(tokens.idToken, {
        clientId,
        nonce: attempt.secrets.nonce,
      });
    } catch (error) {
      await this.#revoke(ownerUserId, issued);
      if (error instanceof IdTokenRejectedError) {
        return this.#fail(ownerUserId, error.check, unverifiableMessage);
      }
      throw error;
    }
    const now = this.#clock();
    const replaced = await this.#store.connect(ownerUserId, {
      clientId,
      tokens: { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken },
      accessExpiresAt: new Date(now.getTime() + tokens.expiresInSeconds * 1000),
      earliestRenewalAt: tokens.earliestRenewalAt,
      accountSubject: account.subject,
      accountEmail: account.email,
      connectedAt: now,
      renewedAt: now,
    });
    // Connecting a plan is asking to use it; Settings says so, and switches back.
    await this.#store.setOpenAiAccess(ownerUserId, "chatgpt_plan");
    this.#logger.info({ ownerUserId }, "Connected a user's ChatGPT plan");
    if (replaced !== undefined) {
      await this.#revoke(ownerUserId, replaced);
    }
    return { kind: "connected" };
  }

  /**
   * A client OpenAI no longer accepts takes the sign-in made with it: that
   * is forgotten, the user told why as for any lost sign-in, and revoked
   * if OpenAI will still take it.
   */
  async #failExchange(ownerUserId: string, failure: TokenFailure): Promise<SignInFinish> {
    if (failure.reason === "client_rejected") {
      const forgotten = await this.#store.forgetClient(ownerUserId, {
        reason: "sign_in_expired",
        at: this.#clock(),
      });
      if (forgotten !== undefined) {
        await this.#revoke(ownerUserId, forgotten);
      }
    }
    return this.#fail(
      ownerUserId,
      failure.code ?? failure.reason,
      describeExchangeFailure(failure),
    );
  }

  /** Once, without waiting for retries: the user is waiting for the page, and a failure is logged. */
  async #revoke(
    ownerUserId: string,
    signIn: { clientId: string; refreshToken: string } | PlanSignIn,
  ): Promise<void> {
    const request =
      "tokens" in signIn
        ? { clientId: signIn.clientId, refreshToken: signIn.tokens.refreshToken }
        : signIn;
    if (!(await this.#client.revoke(request))) {
      this.#logger.warn({ ownerUserId }, "OpenAI did not confirm revoking a ChatGPT sign-in");
    }
  }

  #fail(ownerUserId: string, why: string, message: string): SignInFinish {
    this.#logger.info({ ownerUserId, why }, "A ChatGPT plan sign-in could not be finished");
    return { kind: "failed", message };
  }
}

/**
 * The client to exchange the code with: on a first registration the one
 * OpenAI issued, which its callback must carry; afterwards the one sent,
 * which the callback may repeat but never contradict.
 */
function chooseClientId(attempt: SignInAttempt, returned: string | undefined): string | undefined {
  if (attempt.clientId === dynamicRegistrationClientId) {
    return returned === undefined || returned === dynamicRegistrationClientId
      ? undefined
      : returned;
  }
  return returned === undefined || returned === attempt.clientId ? attempt.clientId : undefined;
}

const beginAgain = "Choose Continue with ChatGPT to begin again.";

function describeUnreadableAddress(problem: FinalAddressProblem): string {
  switch (problem) {
    case "empty":
      return "Paste the address your browser ended on after you approved, starting http://127.0.0.1:1455/auth/callback?";
    case "not_an_address":
      return "That is not a web address. Copy the whole address from your browser's address bar, where the page that failed to load is, and paste it here.";
    case "authorization_page":
      return "That is the address of OpenAI's page, from before you approved. Approve on that page first; your browser then goes to an address starting http://127.0.0.1:1455/auth/callback?, which fails to load. Copy that one.";
    case "elsewhere":
      return "That is not the address the sign-in ends on. After you approve, your browser goes to an address starting http://127.0.0.1:1455/auth/callback?, which fails to load: copy that one, whole.";
    case "cut_short":
      return "That address is cut short: it lacks the code or the state the sign-in needs. Copy the whole address from your browser's address bar, everything after ? included.";
  }
}

function describeUntakenAttempt(kind: "unknown" | "finished_already" | "expired"): string {
  switch (kind) {
    case "unknown":
      return `That address belongs to no sign-in you began here. ${beginAgain}`;
    case "finished_already":
      return `That address was used already: each one works once. ${beginAgain}`;
    case "expired":
      return `That sign-in was begun more than ten minutes ago, and has lapsed. ${beginAgain}`;
  }
}

const declinedMessage = `You chose not to let Barrack use your ChatGPT plan, so nothing was connected. ${beginAgain}`;

/**
 * OpenAI documents only `access_denied` among the errors its callback
 * carries; one naming a policy is taken as a workspace's administrator
 * refusing third-party apps, as earlier reports described.
 */
/**
 * OpenAI's error code, and its own description where the address carries
 * one (`error_description`, read from the address the user pasted, at
 * most 512 characters), which may say more than the code.
 */
function describeOpenAiRefusal(error: string, description: string | undefined): string {
  const said = description === undefined ? `"${error}"` : `"${error}": ${description}`;
  if (/policy/i.test(error)) {
    return `Your ChatGPT workspace does not allow apps like Barrack to use its plan (OpenAI said ${said}). Ask the workspace's administrator to allow it, or use your own API key instead.`;
  }
  return `OpenAI ended the sign-in with an error (${said}), so nothing was connected. ${beginAgain}`;
}

const clientMismatchMessage = `OpenAI's answer named another app than the one this sign-in began with, so it was not used. ${beginAgain}`;

const planUsageNotGrantedMessage =
  "You signed in, but did not allow Barrack to use your ChatGPT plan, so nothing was connected. To run threads on it, begin again and allow plan usage; otherwise use your own API key.";

const unverifiableMessage = `OpenAI's answer could not be verified, so it was not used. ${beginAgain}`;

function describeExchangeFailure(failure: TokenFailure): string {
  switch (failure.reason) {
    case "unusable":
      return `OpenAI no longer accepts that address's code: it lasts only a minute or so, and works once. ${beginAgain}, and paste the new address straight away.`;
    case "client_rejected":
      return `OpenAI no longer accepts Barrack's registration with your account, so it has been forgotten. ${beginAgain}; you will be asked to approve Barrack anew.`;
    case "unavailable":
      return `OpenAI's sign-in could not be reached just now. ${beginAgain} in a moment.`;
    case "refused":
      return `OpenAI refused the sign-in${failure.code === undefined ? "" : ` ("${failure.code}")`}. ${beginAgain}`;
  }
}

/** 32 random bytes as base64url: 43 characters, as PKCE wants of a verifier. */
function randomText(): string {
  return randomBytes(32).toString("base64url");
}

function digestOf(state: string): Buffer {
  return createHash("sha256").update(state).digest();
}
