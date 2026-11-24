/**
 * Resolves true once `promise` settles, however it settles, or false if it
 * has not settled within the timeout. The outcome itself stays with whoever
 * holds the promise.
 */
export function finishesWithin(
  promise: Promise<unknown>,
  timeoutInMilliseconds: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutInMilliseconds);
    const finish = () => {
      clearTimeout(timer);
      resolve(true);
    };
    promise.then(finish, finish);
  });
}
