import { setTimeout as delay } from "node:timers/promises";

const pollIntervalInMilliseconds = 200;
/** Generous, because the first start compiles the sources and warms Vite's cache. */
const timeoutInMilliseconds = 60_000;

/** Resolves once `url` answers an HTTP request successfully, polling until then. */
export async function waitUntilReachable(url: string): Promise<void> {
  const deadline = Date.now() + timeoutInMilliseconds;
  while (Date.now() < deadline) {
    if (await isReachable(url)) {
      return;
    }
    await delay(pollIntervalInMilliseconds);
  }
  throw new Error(`${url} did not answer within ${timeoutInMilliseconds / 1000} seconds.`);
}

async function isReachable(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(pollIntervalInMilliseconds * 5),
    });
    await response.body?.cancel();
    return response.ok;
  } catch {
    // Refused or timed out: the service is not listening yet.
    return false;
  }
}
