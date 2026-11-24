import type { SandboxAdmission } from "../threads/thread-store.js";

/** What an installation configures about its sandboxes' lifecycle; see `configuration.ts`. */
export type SandboxLifecycleSettings = {
  /** How long a running sandbox may go with no activity before it is stopped. */
  idlePeriodInMilliseconds: number;
  /** How many sandboxes may run at once. */
  admission: SandboxAdmission;
  /**
   * How often the control plane compares its records with the provider and
   * looks for idle sandboxes. Also sets how long an operation's lease lasts.
   */
  checkIntervalInMilliseconds: number;
};

/** The current time. Injected so that tests can move it on themselves. */
export type Clock = () => Date;

/** The timings the lifecycle works to, derived from the settings. */
export type LifecycleTiming = {
  /**
   * How long a control plane performing an operation holds it without
   * renewing. Two check intervals: an operation whose control plane has gone
   * is taken over at the second check after its last renewal at the latest.
   */
  leaseDurationInMilliseconds: number;
  /** Renewed four times per lease, so a renewal or two may be late without losing it. */
  leaseRenewalIntervalInMilliseconds: number;
  /** Pauses before trying an unavailable provider again, before giving up. */
  providerRetryDelaysInMilliseconds: readonly number[];
  /** How long a stop waits for the agent to end an interrupted run before stopping the sandbox anyway. */
  interruptGracePeriodInMilliseconds: number;
  /**
   * Agent activity is written at most this often per thread: an agent emits
   * many events a second, and idle shutdown needs to know only that one
   * happened recently, at a precision well within the idle period.
   */
  agentActivityRecordingIntervalInMilliseconds: number;
  /**
   * How long a sandbox recorded running may go without its supervisor
   * attaching before it is stopped and its thread failed, saying why.
   */
  supervisorAttachmentDeadlineInMilliseconds: number;
};

/** A provider that is unavailable may be back in a moment. */
const providerRetryDelaysInMilliseconds = [1_000, 5_000];

/**
 * Pi stops within a few seconds of being interrupted; a stop does not wait
 * for one that does not, since stopping the sandbox ends the run anyway.
 */
const interruptGracePeriodInMilliseconds = 5_000;

const longestAgentActivityRecordingIntervalInMilliseconds = 60_000;

/**
 * A supervisor connects within seconds of its sandbox running; five minutes
 * leaves room for a slow network or a control plane redeploying, and still
 * tells a user whose sandbox can never connect within one cup of coffee.
 */
const supervisorAttachmentDeadlineInMilliseconds = 5 * 60_000;

export function deriveLifecycleTiming(settings: SandboxLifecycleSettings): LifecycleTiming {
  const leaseDurationInMilliseconds = 2 * settings.checkIntervalInMilliseconds;
  return {
    leaseDurationInMilliseconds,
    leaseRenewalIntervalInMilliseconds: leaseDurationInMilliseconds / 4,
    providerRetryDelaysInMilliseconds,
    interruptGracePeriodInMilliseconds,
    agentActivityRecordingIntervalInMilliseconds: Math.min(
      longestAgentActivityRecordingIntervalInMilliseconds,
      settings.idlePeriodInMilliseconds / 4,
    ),
    supervisorAttachmentDeadlineInMilliseconds,
  };
}
