import { setTimeout as sleep } from "node:timers/promises";
import {
  apiErrorResponseSchema,
  buildModelCredentialApiPath,
  buildResumeThreadApiPath,
  buildStopThreadApiPath,
  buildThreadApiPath,
  buildThreadModelApiPath,
  type ThreadSandbox,
  type ThreadSummary,
  threadResponseSchema,
  threadsApiPath,
} from "@barrack/protocol";
import { type RunningControlPlane, testClientOrigin } from "./local-system.js";

/**
 * The control plane's threads API, used as the web page uses it, as the
 * control plane's signed-in test user. Every response is checked with the
 * protocol's own schemas.
 */

type ApiAccess = Pick<RunningControlPlane, "httpBaseUrl" | "accessToken">;

/** What the control plane answered: the thread, or its refusal. */
export type ApiAnswer =
  | { status: number; thread: ThreadSummary }
  | { status: number; errorCode: string; message: string };

const sandboxWaitTimeoutInMilliseconds = 90_000;
const pollIntervalInMilliseconds = 100;

/**
 * Creates a thread as a browser on an allowed origin would, failing unless
 * it is created; on `model` if given, which needs the user's key for it.
 */
export async function createThread(
  controlPlane: ApiAccess,
  model: string | undefined = undefined,
): Promise<ThreadSummary> {
  const answer = await requestCreation(controlPlane, model);
  if (!("thread" in answer)) {
    throw new Error(`Creating a thread answered ${answer.status}: ${answer.message}`);
  }
  return answer.thread;
}

/** Asks for a new thread and returns whatever the control plane answered. */
export function requestCreation(
  controlPlane: ApiAccess,
  model: string | undefined = undefined,
): Promise<ApiAnswer> {
  return send(controlPlane, "POST", threadsApiPath, model === undefined ? {} : { model });
}

/** Switches the thread's model, failing unless it was switched. */
export async function changeThreadModel(
  controlPlane: ApiAccess,
  threadId: string,
  model: string,
): Promise<ThreadSummary> {
  const answer = await send(controlPlane, "PUT", buildThreadModelApiPath(threadId), { model });
  if (!("thread" in answer)) {
    throw new Error(`Switching the model answered ${answer.status}: ${answer.message}`);
  }
  return answer.thread;
}

/** Adds or replaces the user's key for the provider, as Settings does, failing unless saved. */
export async function saveModelCredential(
  controlPlane: ApiAccess,
  providerId: string,
  secret: string,
): Promise<void> {
  const response = await fetch(
    `${controlPlane.httpBaseUrl}${buildModelCredentialApiPath(providerId)}`,
    {
      method: "PUT",
      headers: jsonHeaders(controlPlane),
      body: JSON.stringify({ secret, settings: {} }),
    },
  );
  if (response.status !== 200) {
    throw new Error(`Saving a key answered ${response.status}: ${await response.text()}`);
  }
}

export function stopThread(controlPlane: ApiAccess, threadId: string): Promise<ApiAnswer> {
  return send(controlPlane, "POST", buildStopThreadApiPath(threadId));
}

export function resumeThread(controlPlane: ApiAccess, threadId: string): Promise<ApiAnswer> {
  return send(controlPlane, "POST", buildResumeThreadApiPath(threadId));
}

export function deleteThread(controlPlane: ApiAccess, threadId: string): Promise<ApiAnswer> {
  return send(controlPlane, "DELETE", buildThreadApiPath(threadId));
}

export async function fetchThread(
  controlPlane: ApiAccess,
  threadId: string,
): Promise<ThreadSummary> {
  const response = await fetch(`${controlPlane.httpBaseUrl}${buildThreadApiPath(threadId)}`, {
    headers: { Authorization: `Bearer ${controlPlane.accessToken}` },
  });
  if (response.status !== 200) {
    throw new Error(`Fetching thread ${threadId} answered ${response.status}.`);
  }
  return threadResponseSchema.parse(await response.json()).thread;
}

/** Resolves once a thread being deleted is gone, its sandbox destroyed. */
export async function waitUntilThreadIsGone(
  controlPlane: ApiAccess,
  threadId: string,
): Promise<void> {
  const deadline = Date.now() + sandboxWaitTimeoutInMilliseconds;
  while (Date.now() < deadline) {
    const response = await fetch(`${controlPlane.httpBaseUrl}${buildThreadApiPath(threadId)}`, {
      headers: { Authorization: `Bearer ${controlPlane.accessToken}` },
    });
    if (response.status === 404) {
      return;
    }
    await sleep(pollIntervalInMilliseconds);
  }
  throw new Error(
    `Thread ${threadId} was still there after ${sandboxWaitTimeoutInMilliseconds / 1000} s.`,
  );
}

/** Resolves once the thread's sandbox runs, failing with the reason if it failed. */
export function waitUntilSandboxIsReady(controlPlane: ApiAccess, threadId: string): Promise<void> {
  return waitUntilSandboxIs(controlPlane, threadId, "running");
}

/** Resolves once the thread's sandbox is in `state`, failing at once if it failed instead. */
export async function waitUntilSandboxIs(
  controlPlane: ApiAccess,
  threadId: string,
  state: ThreadSandbox["state"],
): Promise<void> {
  const deadline = Date.now() + sandboxWaitTimeoutInMilliseconds;
  let lastSeen: ThreadSandbox | undefined;
  while (Date.now() < deadline) {
    const { sandbox } = await fetchThread(controlPlane, threadId);
    lastSeen = sandbox;
    if (sandbox.state === state) {
      return;
    }
    if (sandbox.state === "failed") {
      throw new Error(`The sandbox of thread ${threadId} failed: ${sandbox.reason}`);
    }
    await sleep(pollIntervalInMilliseconds);
  }
  throw new Error(
    `The sandbox of thread ${threadId} was still ${JSON.stringify(lastSeen)}, not ${state}, after ${sandboxWaitTimeoutInMilliseconds / 1000} s.`,
  );
}

function jsonHeaders(controlPlane: ApiAccess): Record<string, string> {
  return {
    Origin: testClientOrigin,
    "Content-Type": "application/json",
    Authorization: `Bearer ${controlPlane.accessToken}`,
  };
}

async function send(
  controlPlane: ApiAccess,
  method: "POST" | "PUT" | "DELETE",
  path: string,
  body: object = {},
): Promise<ApiAnswer> {
  const response = await fetch(`${controlPlane.httpBaseUrl}${path}`, {
    method,
    headers: jsonHeaders(controlPlane),
    body: method === "DELETE" ? null : JSON.stringify(body),
  });
  const answer: unknown = await response.json();
  const thread = threadResponseSchema.safeParse(answer);
  if (thread.success) {
    return { status: response.status, thread: thread.data.thread };
  }
  const { error } = apiErrorResponseSchema.parse(answer);
  return { status: response.status, errorCode: error.code, message: error.message };
}
