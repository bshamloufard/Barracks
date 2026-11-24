const firstDelayInMilliseconds = 500;
const longestDelayInMilliseconds = 10_000;

/**
 * How long to wait before reconnection attempt number `attempt` (0 for the
 * first). The delay doubles each time up to a cap, so a page left open while
 * the control plane is down keeps trying without hammering it. Each delay is
 * spread over its upper half at random, so many pages dropped at once (by a
 * control plane restart) do not all reconnect in the same instant.
 */
export function reconnectDelayInMilliseconds(
  attempt: number,
  randomFraction: () => number = Math.random,
): number {
  const cappedDelay = Math.min(firstDelayInMilliseconds * 2 ** attempt, longestDelayInMilliseconds);
  return cappedDelay * (0.5 + randomFraction() / 2);
}
