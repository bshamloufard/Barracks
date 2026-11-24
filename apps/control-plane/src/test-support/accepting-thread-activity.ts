import type { ThreadActivity } from "../thread-relay/thread-activity.js";

/** For tests of the relay alone: every message is admitted, and activity goes nowhere. */
export const acceptingThreadActivity: ThreadActivity = {
  admitUserMessage: async () => ({ isAccepted: true }),
  recordAgentActivity: async () => undefined,
  recordSupervisorAttached: async () => undefined,
};
