import { setTimeout as sleep } from "node:timers/promises";
import {
  buildThreadApiPath,
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

const sandboxWaitTimeoutInMilliseconds = 60_000;
const pollIntervalInMilliseconds = 100;

/** Creates a thread as a browser on an allowed origin would. */
export async function createThread(controlPlane: ApiAccess): Promise<ThreadSummary> {
  const response = await fetch(`${controlPlane.httpBaseUrl}${threadsApiPath}`, {
    method: "POST",
    headers: {
      Origin: testClientOrigin,
      "Content-Type": "application/json",
      Authorization: `Bearer ${controlPlane.accessToken}`,
    },
    body: "{}",
  });
  if (response.status !== 201) {
    throw new Error(`Creating a thread answered ${response.status}: ${await response.text()}`);
  }
  return threadResponseSchema.parse(await response.json()).thread;
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

/** Resolves once the thread's sandbox exists, failing with the reason if it could not be created. */
export async function waitUntilSandboxIsReady(
  controlPlane: ApiAccess,
  threadId: string,
): Promise<void> {
  const deadline = Date.now() + sandboxWaitTimeoutInMilliseconds;
  while (Date.now() < deadline) {
    const { sandbox } = await fetchThread(controlPlane, threadId);
    if (sandbox.state === "ready") {
      return;
    }
    if (sandbox.state === "failed") {
      throw new Error(`The sandbox of thread ${threadId} failed: ${sandbox.reason}`);
    }
    await sleep(pollIntervalInMilliseconds);
  }
  throw new Error(`The sandbox of thread ${threadId} was still being created after a minute.`);
}
