import { z } from "zod";

/**
 * Asks the agent to stop what it is doing. The client sends it to the control
 * plane, which passes it on to the supervisor. User messages the agent has not
 * yet started on are dropped along with the current work, so the interrupted
 * agent stays idle until the user sends something new. The run still ends with
 * `agent_run_settled`, with `wasInterrupted` set.
 */
export const interruptAgentMessageSchema = z.strictObject({
  type: z.literal("interrupt_agent"),
});

export type InterruptAgentMessage = z.infer<typeof interruptAgentMessageSchema>;
