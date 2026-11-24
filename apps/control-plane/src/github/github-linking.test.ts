import { FakeGithub, type FakeRepository } from "@barrack/fake-github";
import { githubConnectionApiPath, githubConnectionResponseSchema } from "@barrack/protocol";
import { TestIdentityIssuer } from "@barrack/test-identity-issuer";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  finishLinkingGithub,
  githubSettingsFor,
  linkGithub,
  startLinkingGithub,
} from "../test-support/github-test-setup.js";
import { browserHeaders, TestControlPlane } from "../test-support/test-control-plane.js";

/**
 * Linking a Barrack user to their GitHub account, through the real control
 * plane against the fake GitHub, with two signed-in users. What a user may
 * use comes only from GitHub, asked with that user's own authorisation;
 * the state that ties GitHub's answer to the user who started is used at
 * most once, by that user, in time.
 */

const ada = { userId: "11111111-1111-4111-8111-111111111111", email: "ada@example.com" };
const grace = { userId: "22222222-2222-4222-8222-222222222222", email: "grace@example.com" };

let github: FakeGithub;
let pushable: FakeRepository;
let readOnly: FakeRepository;
let notInstalled: FakeRepository;
let othersInstallation: FakeRepository;
let issuer: TestIdentityIssuer;
let controlPlane: TestControlPlane;
let now: Date;

beforeAll(async () => {
  github = await FakeGithub.start();
  pushable = await github.createRepository({ owner: "ada", name: "pushable", isPrivate: true });
  readOnly = await github.createRepository({ owner: "team", name: "read-only", isPrivate: true });
  notInstalled = await github.createRepository({
    owner: "ada",
    name: "elsewhere",
    isPrivate: true,
  });
  othersInstallation = await github.createRepository({
    owner: "eve",
    name: "secret",
    isPrivate: true,
  });
  github.addUser({ login: "ada", push: [pushable, notInstalled], read: [readOnly] });
  github.addUser({ login: "eve", push: [othersInstallation] });
  github.installApp([pushable, readOnly]);
  github.installApp([othersInstallation]);
}, 30_000);

afterAll(async () => {
  await github.close();
});

beforeEach(async () => {
  issuer = await TestIdentityIssuer.start();
  now = new Date();
  controlPlane = await TestControlPlane.start({
    authentication: { kind: "test-issuer", issuer },
    github: githubSettingsFor(github),
    clock: () => now,
  });
});

afterEach(async () => {
  await controlPlane.close();
  await issuer.close();
});

function signIn(user: { userId: string; email: string }): Promise<string> {
  return issuer.mintAccessToken(user);
}

async function readConnection(accessToken: string) {
  const response = await controlPlane.getApi(githubConnectionApiPath, accessToken);
  return githubConnectionResponseSchema.parse(await response.json()).connection;
}

describe("linking GitHub", () => {
  it("offers only repositories GitHub says the user can push to, in the App's installations, and keeps no GitHub token", async () => {
    const token = await signIn(ada);

    const connection = await linkGithub(controlPlane, github, "ada", token);

    expect(connection).toMatchObject({ state: "connected", login: "ada" });
    expect(connection.state === "connected" && connection.repositories).toEqual([
      { fullName: "ada/pushable", url: pushable.cloneUrl, defaultBranch: "main", isPrivate: true },
    ]);
    expect(github.requests).toContainEqual(
      expect.objectContaining({ method: "DELETE", credential: "client", status: 204 }),
    );
    expect(controlPlane.logLines.join("\n")).not.toMatch(/ghu_/);
  });

  it("shows each user only their own link", async () => {
    await linkGithub(controlPlane, github, "ada", await signIn(ada));

    expect(await readConnection(await signIn(grace))).toMatchObject({ state: "not_connected" });
  });

  it("refuses to finish with a state another user started, and keeps that state unusable", async () => {
    const adaToken = await signIn(ada);
    const graceToken = await signIn(grace);
    const authorizationUrl = await startLinkingGithub(controlPlane, graceToken);
    const callback = github.approveAuthorization("eve", authorizationUrl);

    const byAda = await finishLinkingGithub(controlPlane, adaToken, callback);
    const byGraceAfterwards = await finishLinkingGithub(controlPlane, graceToken, callback);

    expect(byAda.status).toBe(400);
    expect(byGraceAfterwards.status).toBe(400);
    expect(await readConnection(adaToken)).toMatchObject({ state: "not_connected" });
    expect(await readConnection(graceToken)).toMatchObject({ state: "not_connected" });
  });

  it("refuses a state used once already", async () => {
    const token = await signIn(ada);
    const authorizationUrl = await startLinkingGithub(controlPlane, token);
    const callback = github.approveAuthorization("ada", authorizationUrl);

    expect((await finishLinkingGithub(controlPlane, token, callback)).status).toBe(200);
    expect((await finishLinkingGithub(controlPlane, token, callback)).status).toBe(400);
  });

  it("refuses a state older than ten minutes", async () => {
    const token = await signIn(ada);
    const authorizationUrl = await startLinkingGithub(controlPlane, token);
    const callback = github.approveAuthorization("ada", authorizationUrl);
    now = new Date(now.getTime() + 11 * 60_000);

    expect((await finishLinkingGithub(controlPlane, token, callback)).status).toBe(400);
  });

  it("refuses a state nobody started, and an installation named in the callback, which is never trusted", async () => {
    const token = await signIn(ada);
    const authorizationUrl = await startLinkingGithub(controlPlane, token);
    const { code } = github.approveAuthorization("ada", authorizationUrl);

    const madeUp = await finishLinkingGithub(controlPlane, token, { code, state: "made-up" });
    const withInstallation = await fetch(`${controlPlane.httpBaseUrl}${githubConnectionApiPath}`, {
      method: "POST",
      headers: browserHeaders(token),
      body: JSON.stringify({ code, state: "x", installation_id: 1 }),
    });

    expect(madeUp.status).toBe(400);
    expect(withInstallation.status).toBe(400);
  });

  it("never offers another account's installation, whatever installation a callback names", async () => {
    const connection = await linkGithub(controlPlane, github, "ada", await signIn(ada));

    const offered = connection.state === "connected" ? connection.repositories : [];
    expect(offered.map((repository) => repository.fullName)).not.toContain("eve/secret");
  });

  it("forgets the link when the user disconnects", async () => {
    const token = await signIn(ada);
    await linkGithub(controlPlane, github, "ada", token);

    const response = await fetch(`${controlPlane.httpBaseUrl}${githubConnectionApiPath}`, {
      method: "DELETE",
      headers: browserHeaders(token),
    });

    expect(response.status).toBe(200);
    expect(await readConnection(token)).toMatchObject({ state: "not_connected" });
  });
});

describe("GitHub not set up", () => {
  it("is explained instead of offered", async () => {
    const plain = await TestControlPlane.start({
      authentication: { kind: "test-issuer", issuer },
    });
    try {
      const response = await plain.getApi(githubConnectionApiPath, await signIn(ada));
      const { connection } = githubConnectionResponseSchema.parse(await response.json());
      expect(connection).toMatchObject({
        state: "unavailable",
        reason: expect.stringContaining("not set up"),
      });
    } finally {
      await plain.close();
    }
  });
});
