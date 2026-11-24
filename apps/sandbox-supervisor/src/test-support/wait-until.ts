/** Polls until `isDone` returns true, failing with `description` after the timeout. */
export async function waitUntil(
  isDone: () => boolean,
  description: string,
  timeoutInMilliseconds = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutInMilliseconds;
  while (!isDone()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting until ${description}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Lets timers and I/O run for a while, for checking that something does not happen. */
export function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
