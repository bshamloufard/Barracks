/**
 * How long each stage of stopping Pi may take before the next, harsher one.
 * Together they stay under the 15 seconds a Docker sandbox gives its
 * supervisor to stop (`BARRACK_DOCKER_STOP_TIMEOUT_SECONDS`), so even a Pi
 * that ignores everything is ended by the supervisor, which then reports the
 * run as interrupted, rather than by the container being killed.
 */
export type PiStopTiming = {
  /**
   * How long a stop waits for the command Pi is working on (an interrupt
   * waits for Pi's answer to `abort`, which comes only once the agent is
   * idle) before stopping Pi without waiting for it.
   */
  commandInFlightTimeoutInMilliseconds: number;
  /**
   * How long Pi gets after its input closes. Pi treats end of input as an
   * orderly shutdown that still writes its last events; a signal cuts the
   * event stream off, so signals are only the fallback.
   * https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md
   */
  gracefulExitTimeoutInMilliseconds: number;
  /** How long the agent's processes get after SIGTERM. */
  terminatedExitTimeoutInMilliseconds: number;
  /** How long to wait after SIGKILL before giving up on seeing Pi's process end. */
  killedExitTimeoutInMilliseconds: number;
};

export const defaultPiStopTiming: PiStopTiming = {
  commandInFlightTimeoutInMilliseconds: 3_000,
  gracefulExitTimeoutInMilliseconds: 5_000,
  terminatedExitTimeoutInMilliseconds: 3_000,
  killedExitTimeoutInMilliseconds: 2_000,
};
