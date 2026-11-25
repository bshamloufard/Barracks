import { FakeChatGptSignIn } from "@barrack/fake-chatgpt-sign-in";
import type { Pool } from "pg";
import { pino } from "pino";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CredentialKeyring } from "../model-access/credential-keyring.js";
import { ControllableClock } from "../test-support/controllable-clock.js";
import {
  createTestPool,
  describeWithTestDatabase,
  TestSchemas,
} from "../test-support/test-database.js";
import { PostgresUserStore } from "../users/postgres-user-store.js";
import { ChatGptPlanAccess, PlanRenewalUnavailableError } from "./chatgpt-plan-access.js";
import type { ChatGptPlanStore } from "./chatgpt-plan-store.js";
import { ChatGptSignIn, signInAttemptLifetimeInMilliseconds } from "./chatgpt-sign-in.js";
import { ChatGptSignInClient } from "./chatgpt-sign-in-client.js";
import { InMemoryChatGptPlanStore } from "./in-memory-chatgpt-plan-store.js";
import { PostgresChatGptPlanStore } from "./postgres-chatgpt-plan-store.js";

/**
 * Renewing a connected plan's sign-in, whose refresh token rotates and is
 * refused if used twice, against a stand-in for OpenAI's sign-in that
 * revokes a whole sign-in on reuse. The same tests run on the in-memory
 * store and, given a test database, on Postgres, where several control
 * planes share one sign-in.
 */

const owner = "11111111-1111-4111-8111-111111111111";
const keyring = new CredentialKeyring(Buffer.alloc(32, 9));
const silentLogger = pino({ level: "silent" });

/** Past the access token's hour, less the five minutes' margin. */
const untilRenewalIsDue = 56 * 60_000;

/** One control plane's view of a shared store. */
type ControlPlaneView = { signIn: ChatGptSignIn; access: ChatGptPlanAccess };

type StoreUnderTest = {
  /** A store as one more control plane would open it, sharing what the others keep. */
  openStore(): Promise<ChatGptPlanStore>;
  close(): Promise<void>;
};

let signInServer: FakeChatGptSignIn;
let clock: ControllableClock;

beforeEach(async () => {
  signInServer = await FakeChatGptSignIn.start();
  signInServer.addAccount({
    subject: "chatgpt-owner",
    email: "owner@chatgpt.example",
    isEligible: true,
  });
  clock = new ControllableClock(new Date());
});

afterEach(async () => {
  await signInServer.close();
});

function openView(store: ChatGptPlanStore): ControlPlaneView {
  const client = new ChatGptSignInClient(signInServer.issuer);
  return {
    signIn: new ChatGptSignIn({ store, client, clock: clock.now, logger: silentLogger }),
    access: new ChatGptPlanAccess({
      settings: { isOffered: true, issuer: signInServer.issuer },
      store,
      client,
      clock: clock.now,
      logger: silentLogger,
      sleep: async () => undefined,
    }),
  };
}

async function connect(view: ControlPlaneView): Promise<void> {
  const { authorizationUrl } = await view.signIn.start(owner);
  const finish = await view.signIn.finish(
    owner,
    signInServer.approve(authorizationUrl, "chatgpt-owner"),
  );
  expect(finish).toEqual({ kind: "connected" });
}

async function accessTokenOf(view: ControlPlaneView): Promise<string> {
  const token = await view.access.findAccessToken(owner);
  if (token.kind !== "token") {
    throw new Error("The plan is not connected.");
  }
  return token.accessToken;
}

function describeRenewal(storeName: string, createStore: () => Promise<StoreUnderTest>): void {
  describe(`renewing a ChatGPT plan's sign-in (${storeName})`, () => {
    let underTest: StoreUnderTest;
    let view: ControlPlaneView;

    beforeEach(async () => {
      underTest = await createStore();
      view = openView(await underTest.openStore());
      await connect(view);
    });

    afterEach(async () => {
      await underTest.close();
    });

    it("uses the access token as it is until five minutes before it expires", async () => {
      const first = await accessTokenOf(view);
      clock.advanceBy(untilRenewalIsDue - 120_000);

      expect(await accessTokenOf(view)).toBe(first);
      expect(signInServer.refreshAttempts).toEqual([]);
    });

    it("renews it after that, keeping the replacement refresh token in place of the one spent", async () => {
      const store = await underTest.openStore();
      const before = await store.readSignIn(owner);
      clock.advanceBy(untilRenewalIsDue);

      const renewed = await accessTokenOf(view);

      const after = await store.readSignIn(owner);
      expect(renewed).not.toBe(before?.tokens.accessToken);
      expect(after?.tokens.refreshToken).not.toBe(before?.tokens.refreshToken);
      expect(signInServer.checkAccessToken(renewed).kind).toBe("valid");
      expect(signInServer.refreshAttempts).toEqual([{ outcome: "renewed" }]);
    });

    it("keeps the replacement refresh token from an answer whose other members are odd", async () => {
      clock.advanceBy(untilRenewalIsDue);
      signInServer.nextTokenAnswerChanges = {
        expires_in: "3600",
        token_type: "mac",
        id_token: 5,
        scope: undefined,
        earliest_refresh_at: { at: "soon" },
      };

      const renewed = await accessTokenOf(view);
      clock.advanceBy(untilRenewalIsDue);
      const renewedAgain = await accessTokenOf(view);

      expect(signInServer.checkAccessToken(renewed).kind).toBe("valid");
      expect(signInServer.checkAccessToken(renewedAgain).kind).toBe("valid");
      expect(signInServer.refreshAttempts).toEqual([
        { outcome: "renewed" },
        { outcome: "renewed" },
      ]);
    });

    it("renews once however many requests ask at once, every one of them getting the new token", async () => {
      clock.advanceBy(untilRenewalIsDue);
      signInServer.refreshDelayInMilliseconds = 200;
      const views = [
        view,
        view,
        openView(await underTest.openStore()),
        openView(await underTest.openStore()),
      ];

      const tokens = await Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          accessTokenOf(views[index % views.length] ?? view),
        ),
      );

      expect(new Set(tokens).size).toBe(1);
      expect(signInServer.refreshAttempts).toEqual([{ outcome: "renewed" }]);
    });

    it("never spends a refresh token twice, renewal after renewal, from every control plane", async () => {
      const views = [view, openView(await underTest.openStore())];
      for (let round = 0; round < 4; round += 1) {
        clock.advanceBy(untilRenewalIsDue);
        await Promise.all(views.map((each) => accessTokenOf(each)));
      }

      expect(signInServer.refreshAttempts.map((attempt) => attempt.outcome)).toEqual([
        "renewed",
        "renewed",
        "renewed",
        "renewed",
      ]);
      expect(signInServer.isSignInRevoked("chatgpt-owner")).toBe(false);
    });

    it("renews with the latest refresh token after a control plane starts again", async () => {
      clock.advanceBy(untilRenewalIsDue);
      await accessTokenOf(view);
      const restarted = openView(await underTest.openStore());

      clock.advanceBy(untilRenewalIsDue);
      const token = await accessTokenOf(restarted);

      expect(signInServer.checkAccessToken(token).kind).toBe("valid");
      expect(signInServer.refreshAttempts.map((attempt) => attempt.outcome)).toEqual([
        "renewed",
        "renewed",
      ]);
    });

    it("keeps the sign-in when OpenAI cannot be reached, and renews it once it can", async () => {
      clock.advanceBy(untilRenewalIsDue);
      signInServer.failTokenRequestsWithStatus = 503;

      await expect(view.access.findAccessToken(owner)).rejects.toBeInstanceOf(
        PlanRenewalUnavailableError,
      );
      expect(await view.access.isConnected(owner)).toBe(true);

      signInServer.failTokenRequestsWithStatus = undefined;
      expect(signInServer.checkAccessToken(await accessTokenOf(view)).kind).toBe("valid");
    });

    it("forgets a sign-in OpenAI will not renew, so the user is told to connect again", async () => {
      signInServer.revokeEverySignInOf("chatgpt-owner");
      clock.advanceBy(untilRenewalIsDue);

      expect(await view.access.findAccessToken(owner)).toEqual({ kind: "not_connected" });

      const status = await view.access.describe(owner);
      expect(status.connection).toBeNull();
      expect(status.loss).toEqual({ reason: "sign_in_expired", at: clock.now().toISOString() });
      // Still the plan, so the user's threads stop with a reason rather than spend their key.
      expect(status.openAiAccess).toBe("chatgpt_plan");
    });

    it("renews at once after OpenAI refuses the access token, and only once for that token", async () => {
      const refused = await accessTokenOf(view);
      // The stand-in dates `earliest_refresh_at` by the real clock, to the
      // second, which may be just past this test's clock, frozen before it.
      clock.advanceBy(1_000);

      await view.access.renewAfterRefusal(owner, refused);
      await view.access.renewAfterRefusal(owner, refused);

      expect(await accessTokenOf(view)).not.toBe(refused);
      expect(signInServer.refreshAttempts).toEqual([{ outcome: "renewed" }]);
    });

    it("clears the loss once the plan is connected again", async () => {
      signInServer.revokeEverySignInOf("chatgpt-owner");
      clock.advanceBy(untilRenewalIsDue);
      await view.access.findAccessToken(owner);

      await connect(view);

      expect(await view.access.describe(owner)).toMatchObject({ loss: null });
    });

    it("refuses an address pasted after its sign-in lapsed", async () => {
      const { authorizationUrl } = await view.signIn.start(owner);
      const finalAddress = signInServer.approve(authorizationUrl, "chatgpt-owner");
      clock.advanceBy(signInAttemptLifetimeInMilliseconds + 1);

      const finish = await view.signIn.finish(owner, finalAddress);

      expect(finish).toEqual({
        kind: "failed",
        message: expect.stringContaining("more than ten minutes ago, and has lapsed"),
      });
    });
  });
}

describeRenewal("in memory", async () => {
  const store = new InMemoryChatGptPlanStore(keyring);
  return { openStore: async () => store, close: async () => undefined };
});

describeWithTestDatabase("on Postgres", () => {
  let setupPool: Pool;
  let schemas: TestSchemas;

  beforeAll(() => {
    setupPool = createTestPool(2);
    schemas = new TestSchemas(setupPool);
  });

  afterAll(async () => {
    await schemas.dropAll();
    await setupPool.end();
  });

  describeRenewal("Postgres, a pool for each control plane", async () => {
    const schema = await schemas.createMigrated();
    await new PostgresUserStore(setupPool, schema).recordUser(owner, undefined);
    const pools: Pool[] = [];
    return {
      openStore: async () => {
        const pool = createTestPool(3);
        pools.push(pool);
        return new PostgresChatGptPlanStore(pool, keyring, schema);
      },
      close: async () => {
        await Promise.all(pools.map((pool) => pool.end()));
      },
    };
  });
});
