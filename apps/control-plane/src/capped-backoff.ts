/** How long to wait between attempts to reach something that may come back. */
export type CappedBackoff = {
  firstDelayInMilliseconds: number;
  longestDelayInMilliseconds: number;
};

/**
 * The wait before the attempt after `failedAttempt` (1 for the first):
 * doubling from the first delay, never longer than the longest.
 */
export function delayAfterFailedAttempt(backoff: CappedBackoff, failedAttempt: number): number {
  return Math.min(
    backoff.firstDelayInMilliseconds * 2 ** (failedAttempt - 1),
    backoff.longestDelayInMilliseconds,
  );
}
