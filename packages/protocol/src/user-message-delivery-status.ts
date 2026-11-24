import { z } from "zod";

/**
 * How far the thread's user messages have reached the agent. Every
 * `user_message` thread event at or before `deliveredThroughSequence` has
 * been handed to the agent; any later one is recorded and waiting, and will
 * be handed over in order once the thread's supervisor connects. A message
 * can be sent while no agent is connected (its sandbox may be starting, or
 * asleep), so this is how a client tells the user that a message is waiting
 * for the agent rather than lost.
 *
 * Sent after the replay and again whenever it advances. It never goes back.
 */
export const userMessageDeliveryStatusSchema = z.strictObject({
  type: z.literal("user_message_delivery_status"),
  deliveredThroughSequence: z.int().nonnegative(),
});

export type UserMessageDeliveryStatus = z.infer<typeof userMessageDeliveryStatusSchema>;
