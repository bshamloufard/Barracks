import { readdir } from "node:fs/promises";
import path from "node:path";
import type { FakeGithub } from "@barrack/fake-github";
import {
  apiErrorResponseSchema,
  buildPublishThreadApiPath,
  type GithubConnection,
  githubConnectionApiPath,
  githubConnectionAttemptsApiPath,
  githubConnectionResponseSchema,
  type PublishThreadResponse,
  publishThreadResponseSchema,
  startGithubConnectionResponseSchema,
  type ThreadRepositoryRequest,
  type ThreadSummary,
  threadResponseSchema,
  threadsApiPath,
} from "@barrack/protocol";
import { type RunningControlPlane, testClientOrigin } from "./local-system.js";

/**
 * The repository and GitHub parts of the control plane's API, used as the
 * web page uses them, as the control plane's signed-in test user.
 */

type ApiAccess = Pick<RunningControlPlane, "httpBaseUrl" | "accessToken">;

export type Refusal = { status: number; errorCode: string; message: string };

function headers(controlPlane: ApiAccess): Record<string, string> {
  return {
    Origin: testClientOrigin,
    "Content-Type": "application/json",
    Authorization: `Bearer ${controlPlane.accessToken}`,
  };
}

async function readRefusal(response: Response): Promise<Refusal> {
  const { error } = apiErrorResponseSchema.parse(await response.json());
  return { status: response.status, errorCode: error.code, message: error.message };
}

/**
 * Links the test user's GitHub account as a person would: start, approve on
 * (the fake) GitHub as `login`, and hand the code and state back.
 */
export async function connectGithub(
  controlPlane: ApiAccess,
  github: FakeGithub,
  login: string,
): Promise<GithubConnection> {
  const started = await fetch(`${controlPlane.httpBaseUrl}${githubConnectionAttemptsApiPath}`, {
    method: "POST",
    headers: headers(controlPlane),
    body: "{}",
  });
  const { authorizationUrl } = startGithubConnectionResponseSchema.parse(await started.json());
  const approval = github.approveAuthorization(login, authorizationUrl);
  const finished = await fetch(`${controlPlane.httpBaseUrl}${githubConnectionApiPath}`, {
    method: "POST",
    headers: headers(controlPlane),
    body: JSON.stringify(approval),
  });
  if (finished.status !== 200) {
    throw new Error(`Connecting GitHub answered ${finished.status}: ${await finished.text()}`);
  }
  return githubConnectionResponseSchema.parse(await finished.json()).connection;
}

export async function createThreadOnRepository(
  controlPlane: ApiAccess,
  repository: ThreadRepositoryRequest,
): Promise<ThreadSummary> {
  const response = await fetch(`${controlPlane.httpBaseUrl}${threadsApiPath}`, {
    method: "POST",
    headers: headers(controlPlane),
    body: JSON.stringify({ repository }),
  });
  if (response.status !== 201) {
    throw new Error(`Creating a thread answered ${response.status}: ${await response.text()}`);
  }
  return threadResponseSchema.parse(await response.json()).thread;
}

export async function publishThread(
  controlPlane: ApiAccess,
  threadId: string,
  openPullRequest: boolean,
): Promise<PublishThreadResponse | Refusal> {
  const response = await fetch(
    `${controlPlane.httpBaseUrl}${buildPublishThreadApiPath(threadId)}`,
    { method: "POST", headers: headers(controlPlane), body: JSON.stringify({ openPullRequest }) },
  );
  if (response.status !== 200) {
    return readRefusal(response);
  }
  return publishThreadResponseSchema.parse(await response.json());
}

/** The one local-process sandbox's workspace under `sandboxesDirectory`. */
export async function findOnlyLocalWorkspace(sandboxesDirectory: string): Promise<string> {
  const sandboxes = (await readdir(sandboxesDirectory)).filter((entry) =>
    entry.startsWith("local-"),
  );
  const [sandbox] = sandboxes;
  if (sandbox === undefined || sandboxes.length !== 1) {
    throw new Error(`Expected one local sandbox, found ${sandboxes.length}.`);
  }
  return path.join(sandboxesDirectory, sandbox, "workspace");
}
