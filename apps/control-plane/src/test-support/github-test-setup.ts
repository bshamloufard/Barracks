import { createPrivateKey } from "node:crypto";
import type { FakeGithub } from "@barrack/fake-github";
import {
  type GithubConnection,
  githubConnectionApiPath,
  githubConnectionAttemptsApiPath,
  githubConnectionResponseSchema,
  startGithubConnectionResponseSchema,
} from "@barrack/protocol";
import { GithubApi } from "../github/github-api.js";
import type { GithubSettings } from "../github/github-settings.js";
import { browserHeaders, type TestControlPlane } from "./test-control-plane.js";

/** The settings of a control plane whose GitHub App is the fake's. */
export function githubSettingsFor(github: FakeGithub): GithubSettings {
  return {
    app: {
      clientId: github.clientId,
      clientSecret: github.clientSecret,
      privateKey: createPrivateKey(github.privateKeyPem),
      slug: github.slug,
    },
    webUrl: github.webUrl,
    apiUrl: github.apiUrl,
    allowPlainHttp: true,
  };
}

/** A client of the fake GitHub's API, as the fake's App. */
export function githubApiFor(github: FakeGithub): GithubApi {
  return new GithubApi({
    app: {
      clientId: github.clientId,
      clientSecret: github.clientSecret,
      privateKey: createPrivateKey(github.privateKeyPem),
      slug: github.slug,
    },
    webUrl: github.webUrl,
    apiUrl: github.apiUrl,
  });
}

/** Starts linking GitHub as the token's user; returns the address the user is sent to. */
export async function startLinkingGithub(
  controlPlane: TestControlPlane,
  accessToken: string,
): Promise<string> {
  const response = await fetch(`${controlPlane.httpBaseUrl}${githubConnectionAttemptsApiPath}`, {
    method: "POST",
    headers: browserHeaders(accessToken),
    body: "{}",
  });
  return startGithubConnectionResponseSchema.parse(await response.json()).authorizationUrl;
}

/** Hands back what GitHub put in the callback, as the token's user. */
export function finishLinkingGithub(
  controlPlane: TestControlPlane,
  accessToken: string,
  callback: { code: string; state: string },
): Promise<Response> {
  return fetch(`${controlPlane.httpBaseUrl}${githubConnectionApiPath}`, {
    method: "POST",
    headers: browserHeaders(accessToken),
    body: JSON.stringify(callback),
  });
}

/** Links the token's user to the fake GitHub's `login`, as a person approving on GitHub would. */
export async function linkGithub(
  controlPlane: TestControlPlane,
  github: FakeGithub,
  login: string,
  accessToken: string,
): Promise<GithubConnection> {
  const authorizationUrl = await startLinkingGithub(controlPlane, accessToken);
  const response = await finishLinkingGithub(
    controlPlane,
    accessToken,
    github.approveAuthorization(login, authorizationUrl),
  );
  if (response.status !== 200) {
    throw new Error(`Linking GitHub answered ${response.status}: ${await response.text()}`);
  }
  return githubConnectionResponseSchema.parse(await response.json()).connection;
}
