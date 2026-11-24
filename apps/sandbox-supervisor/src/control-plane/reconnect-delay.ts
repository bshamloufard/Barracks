export type ReconnectDelaySettings = {
  initialDelayInMilliseconds: number;
  maximumDelayInMilliseconds: number;
};

/**
 * Exponential backoff with jitter: the delay doubles with each failed attempt
 * up to the maximum, and a random part spreads supervisors out so that a
 * restarted control plane is not hit by all of them at the same moment.
 * Half of each delay is fixed, so a reconnect is never immediate.
 *
 * `attempt` counts from 0 for the first retry after a disconnect.
 */
export function computeReconnectDelay(
  attempt: number,
  settings: ReconnectDelaySettings,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(
    settings.maximumDelayInMilliseconds,
    settings.initialDelayInMilliseconds * 2 ** attempt,
  );
  return ceiling / 2 + random() * (ceiling / 2);
}
