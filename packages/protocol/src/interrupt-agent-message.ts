import { z } from "zod";

/**
 * Asks the agent to stop what it is doing. The client sends it to the control
 * plane, which passes it on to the supervisor. User messages the agent has not
 * yet started on are dropped along with the current work, so the interrupted
 * agent stays idle until the user sends something new. The run still ends with
 * `agent_run_settled`, with `wasInterrupted` set.
 *
 * Unlike user messages, an interrupt is delivered at most once: it is sent
 * only to a supervisor connected at that moment, never stored, and never
 * resent after a reconnection, because arriving late it would stop whatever
 * the agent was doing by then. One lost with a dying connection shows as a
 * run that did not stop, and the user can interrupt again.
 */
export const interruptAgentMessageSchema = z.strictObject({
  type: z.literal("interrupt_agent"),
});

export type InterruptAgentMessage = z.infer<typeof interruptAgentMessageSchema>;
